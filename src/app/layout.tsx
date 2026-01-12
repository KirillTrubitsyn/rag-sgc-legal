import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'RAG SGC Legal',
  description: 'RAG система для работы с юридическими документами',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru">
      <body>
        {children}
      </body>
    </html>
  );
}
