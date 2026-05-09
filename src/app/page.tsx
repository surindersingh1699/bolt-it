import { StateProvider } from "./components/StateProvider";
import { AppShell } from "./components/AppShell";

export default function Home() {
  return (
    <StateProvider>
      <AppShell />
    </StateProvider>
  );
}
