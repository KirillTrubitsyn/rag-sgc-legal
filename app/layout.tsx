import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'RAG SGC Legal',
  description: 'Юридический ассистент СГК для работы с нормативами и стандартами',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru">
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}
