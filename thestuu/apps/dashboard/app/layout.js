import './globals.css';

export const metadata = {
  title: 'TheStuu Dashboard',
  description: 'AI-native headless DAW dashboard',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
