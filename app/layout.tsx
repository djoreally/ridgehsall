import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ridgehsall — email list batching",
  description: "Ingest contact lists, set a frequency, and let the scheduler deal out compliant daily batches.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="wrap">
          <header className="top">
            <h1><a href="/">ridgehsall</a></h1>
            <span className="muted small">v0 prototype · email list batching</span>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
