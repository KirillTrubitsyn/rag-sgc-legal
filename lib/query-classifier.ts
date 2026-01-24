/**
 * Интеллектуальный классификатор запросов на основе LLM
 *
 * Анализирует контекст и смысл запроса пользователя,
 * определяя наиболее подходящую коллекцию документов.
 */

import { COLLECTIONS_CONFIG, detectCollection } from './collections-config';

// Результат классификации
export interface ClassificationResult {
  collectionKey: string | null;
  confidence: number; // 0-1, где 1 = полная уверенность
  reasoning: string;  // Объяснение выбора для отладки
  needsClarification: boolean;
  clarificationQuestion?: string; // Уточняющий вопрос если needsClarification=true
}

// Описания коллекций для промпта классификатора
const COLLECTION_DESCRIPTIONS = `
1. **poa** (Доверенности) - Документы о полномочиях сотрудников:
   - Кто может подписывать договоры, акты, письма
   - Какие полномочия у конкретного сотрудника
   - Лимиты и ограничения по суммам
   - Право представлять интересы компании

2. **contractForms** (Формы договоров) - Шаблоны и СОДЕРЖАНИЕ типовых договоров:
   - Какие условия/пункты содержит типовой договор
   - Какая неустойка/штрафы предусмотрены в договоре
   - Условия оплаты, поставки, гарантии в шаблоне
   - Скачать/получить форму договора

3. **articlesOfAssociation** (Уставы) - Уставы организаций группы СГК:
   - Компетенция органов управления (совет директоров, собрание)
   - Порядок принятия решений, кворум, голосование
   - Одобрение крупных сделок
   - Уставной капитал, реорганизация

4. **standardsAndRegulations** (Стандарты и регламенты) - Нормативные документы о ПРОЦЕССАХ и ПОРЯДКЕ РАБОТЫ:
   - КАК организовать работу, какой порядок действий
   - Процедуры: подача исков, претензионная работа, согласование
   - Регламенты и инструкции по выполнению задач
   - Стандарты и правила внутренней работы
`;

const CLASSIFICATION_PROMPT = `Ты - интеллектуальный маршрутизатор запросов для юридической системы поиска документов.

ДОСТУПНЫЕ КОЛЛЕКЦИИ ДОКУМЕНТОВ:
${COLLECTION_DESCRIPTIONS}

ВАЖНЫЕ ПРАВИЛА КЛАССИФИКАЦИИ:

1. **Процедурные вопросы** ("как организовать", "какой порядок", "что делать", "как подать") → standardsAndRegulations
   Пример: "Как организовать подачу иска о взыскании неустойки" - это вопрос о ПРОЦЕДУРЕ, а не о содержании договора

2. **Вопросы о содержании договоров** ("какая неустойка в договоре", "какие условия", "что предусмотрено") → contractForms
   Пример: "Какая неустойка предусмотрена в договоре подряда" - это вопрос о СОДЕРЖАНИИ договора

3. **Вопросы о полномочиях людей** ("кто может подписать", "какие полномочия у") → poa

4. **Вопросы о компетенции органов** ("кто принимает решение", "нужно ли одобрение совета") → articlesOfAssociation

5. **Follow-up запросы** (продолжение диалога):
   - Если запрос явно продолжает предыдущую тему ("сведи в таблицу", "подробнее", "ещё раз"), используй ту же коллекцию
   - Такие запросы имеют высокую уверенность, если понятен контекст

ЗАДАЧА:
Проанализируй запрос пользователя и определи:
1. О ЧЁМ спрашивает пользователь - о процедуре/порядке действий или о содержании документа?
2. Какая коллекция лучше всего подходит?
3. Насколько ты уверен в выборе (0.0-1.0)?

Если уверенность < 0.7, нужно уточнение. Сформулируй вежливый уточняющий вопрос.

{context}

ТЕКУЩИЙ ЗАПРОС ПОЛЬЗОВАТЕЛЯ:
"{query}"

Ответь СТРОГО в формате JSON:
{
  "collection": "poa" | "contractForms" | "articlesOfAssociation" | "standardsAndRegulations" | null,
  "confidence": 0.0-1.0,
  "reasoning": "краткое объяснение выбора",
  "needsClarification": true | false,
  "clarificationQuestion": "уточняющий вопрос если needsClarification=true, иначе null"
}`;

/**
 * Классифицирует запрос с помощью LLM, учитывая контекст диалога
 */
export async function classifyQueryWithLLM(
  query: string,
  apiKey: string,
  conversationContext?: string // Контекст предыдущих сообщений
): Promise<ClassificationResult> {
  try {
    // Формируем контекст для промпта
    const contextSection = conversationContext
      ? `КОНТЕКСТ ДИАЛОГА (предыдущие сообщения):\n${conversationContext}\n`
      : '';

    const prompt = CLASSIFICATION_PROMPT
      .replace('{context}', contextSection)
      .replace('{query}', query);

    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'grok-4-1-fast',
        messages: [
          {
            role: 'system',
            content: 'Ты - классификатор запросов. Отвечай ТОЛЬКО валидным JSON без markdown-форматирования.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.1,
        max_tokens: 500,
      }),
    });

    if (!response.ok) {
      console.error('LLM classification failed:', response.status);
      return fallbackToKeywords(query);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';

    // Парсим JSON из ответа
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('Failed to parse LLM response:', content);
      return fallbackToKeywords(query);
    }

    const result = JSON.parse(jsonMatch[0]);

    console.log('LLM Classification:', {
      query: query.substring(0, 50) + '...',
      collection: result.collection,
      confidence: result.confidence,
      reasoning: result.reasoning
    });

    const needsClarification = result.needsClarification || result.confidence < 0.7;

    return {
      collectionKey: result.collection,
      confidence: result.confidence || 0.5,
      reasoning: result.reasoning || '',
      needsClarification,
      // Всегда генерируем clarificationQuestion если нужно уточнение
      clarificationQuestion: needsClarification
        ? (result.clarificationQuestion || generateClarificationQuestion())
        : undefined,
    };

  } catch (error) {
    console.error('LLM classification error:', error);
    return fallbackToKeywords(query);
  }
}

/**
 * Fallback на поиск по ключевым словам
 * Используется при ошибках LLM или как дополнительная проверка
 */
function fallbackToKeywords(query: string): ClassificationResult {
  const collectionKey = detectCollection(query);

  if (collectionKey) {
    return {
      collectionKey,
      confidence: 0.6, // Средняя уверенность для keyword-based
      reasoning: 'Определено по ключевым словам (fallback)',
      needsClarification: false,
    };
  }

  return {
    collectionKey: null,
    confidence: 0,
    reasoning: 'Не удалось определить коллекцию',
    needsClarification: true,
    clarificationQuestion: generateClarificationQuestion(),
  };
}

/**
 * Генерирует уточняющий вопрос со списком коллекций
 */
function generateClarificationQuestion(): string {
  const collections = Object.entries(COLLECTIONS_CONFIG)
    .map(([key, config]) => `• **${config.displayName}** — ${config.description}`)
    .join('\n');

  return `Уточните, пожалуйста, в какой области вы ищете информацию:\n\n${collections}`;
}

/**
 * Гибридная классификация: LLM + ключевые слова
 * Использует LLM для понимания контекста, но проверяет результат через ключевые слова
 */
export async function hybridClassifyQuery(
  query: string,
  apiKey: string
): Promise<ClassificationResult> {
  // Сначала проверяем ключевые слова - если есть очень специфичное совпадение, используем его
  const keywordResult = detectCollection(query);

  // Если нет совпадений по ключевым словам или уверенность низкая - используем LLM
  const llmResult = await classifyQueryWithLLM(query, apiKey);

  // Если LLM уверен (>= 0.8) - используем его результат
  if (llmResult.confidence >= 0.8) {
    return llmResult;
  }

  // Если есть совпадение по ключевым словам и LLM не уверен - используем ключевые слова
  if (keywordResult && llmResult.confidence < 0.8) {
    // Но если LLM сказал другую коллекцию с уверенностью > 0.5 - нужно уточнение
    if (llmResult.collectionKey &&
        llmResult.collectionKey !== keywordResult &&
        llmResult.confidence > 0.5) {
      return {
        collectionKey: null,
        confidence: 0.5,
        reasoning: `Конфликт: ключевые слова → ${keywordResult}, LLM → ${llmResult.collectionKey}`,
        needsClarification: true,
        clarificationQuestion: llmResult.clarificationQuestion || generateClarificationQuestion(),
      };
    }

    return {
      collectionKey: keywordResult,
      confidence: 0.7,
      reasoning: `Определено по ключевым словам, подтверждено LLM`,
      needsClarification: false,
    };
  }

  // В остальных случаях используем результат LLM
  return llmResult;
}
