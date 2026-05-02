import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Ad Generator',
  description: 'AI-powered ad production pipeline',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
