import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "新加坡租房助手",
  description: "多轮对话找房 —— 说清需求，看到取舍",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
