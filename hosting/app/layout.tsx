import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Shard Atlas",
  description: "Your private library of connected technical knowledge.",
  icons: {
    icon: "/icon.svg",
    shortcut: "/icon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
