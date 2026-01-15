import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Юридическая служба СГК',
  description: 'Система поиска по документам Юридической службы Сибирской генерирующей компании',
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
