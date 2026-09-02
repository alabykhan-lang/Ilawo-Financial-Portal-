import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./accessibility.css";

export const metadata: Metadata = {
  title: "Ilawo Financial Portal",
  description: "Secure school financial records for Ilawo Community Grammar School, Ilawo.",
  applicationName: "Ilawo Financial Portal",
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = {
  themeColor: "#185e63",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-NG">
      <body>{children}</body>
    </html>
  );
}
