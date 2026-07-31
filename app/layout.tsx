import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Singapore Rental Assistant",
  description: "Find a place through conversation — state what you need, see the trade-offs",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
