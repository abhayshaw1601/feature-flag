import { AppShell } from "@/components/shell/app-shell";
import { FlagsPage } from "@/components/flags/flags-page";

export default function HomePage() {
  return (
    <AppShell>
      <FlagsPage />
    </AppShell>
  );
}
