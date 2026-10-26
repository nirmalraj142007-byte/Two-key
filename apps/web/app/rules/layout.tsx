import { SetupHeader } from '../onboarding/progress';

export default function RulesLayout({ children }: LayoutProps<'/rules'>) {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-10">
      <SetupHeader />
      {children}
    </main>
  );
}
