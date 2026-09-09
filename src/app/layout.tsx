import type { Metadata } from "next";
import { Geist, Geist_Mono, JetBrains_Mono } from "next/font/google";

import { TooltipProvider } from "@/components/ui/tooltip";

import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
// The terminal's face. Geist Mono is drawn for code on a page and has no box
// drawing at all, so an agent's TUI borders came from whatever the system fell
// back to and never lined up with the text beside them.
const terminalMono = JetBrains_Mono({ variable: "--font-terminal-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Agent Board",
  description: "Kanban board that runs coding agents",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-theme="dark">
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${terminalMono.variable} antialiased`}
      >
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  );
}
