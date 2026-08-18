import "@/App.css";
import AccountForm from "@/components/account-form";
import DateList from "@/components/date-list";
import FavoritesForm from "@/components/favorites-form";
import OpenMemberPageButton from "@/components/open-member-page-button";
import PreferencesForm from "@/components/preferences-form";
import RefreshDateListButton from "@/components/refresh-date-list-button";
import Version from "@/components/version";
import { useAccount, useTaskParameters } from "@/lib/queries";
import { useResetWhenAway } from "@/lib/use-reset-when-away";
import { useUpdateCheck } from "@/lib/use-update-check";

export default function App() {
  const accountQuery = useAccount();
  const taskParametersQuery = useTaskParameters();
  useResetWhenAway();
  useUpdateCheck();

  if (accountQuery.isPending) {
    return null;
  }

  return (
    <div className="flex [&_svg]:flex-none">
      <header className="sticky bottom-0 z-10 mt-auto flex h-screen flex-col justify-end gap-2 p-2">
        {taskParametersQuery.isSuccess && <OpenMemberPageButton />}
        {accountQuery.data && <RefreshDateListButton />}
        {taskParametersQuery.isSuccess && (
          <>
            <FavoritesForm />
            <PreferencesForm />
          </>
        )}
        <AccountForm />
      </header>
      <main className="flex flex-1 flex-col items-center gap-4 py-4 pr-4">
        <p className="text-muted-foreground">
          © {new Date().getFullYear()} FlexiRent. All rights reserved.
        </p>
        {accountQuery.data && <DateList />}
      </main>
      <Version className="absolute top-2.5 right-3" />
    </div>
  );
}
