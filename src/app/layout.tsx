import type { ReactNode } from "react";
import type { Metadata } from "next";
import "./globals.css";

/** Allow Snowflake + Serper + multi-page scrapes on Vercel (raise on Pro if needed). */
export const maxDuration = 60;

export const metadata: Metadata = {
  title: "CPT Code Search",
  description:
    "Look up CPT codes with source-backed summaries and optional Snowflake SRT context.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
