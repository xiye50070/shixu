import type { Metadata } from "next";
import "@copilotkit/react-core/v2/styles.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "拾序 · Shixu Work",
  description: "用项目组织任务，与 DeepSeek Agent 连续协作。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body className="ow-ee" data-ow-profile="saas" data-density="standard">{children}</body></html>;
}
