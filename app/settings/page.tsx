import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { hasAdultPin } from "@/lib/adult-gate";
import { ensureUserProfile } from "@/lib/profiles";
import { userHomeDir } from "@/lib/storage-roots";
import SettingsShell from "@/components/settings-shell";

export const dynamic = "force-dynamic";

/**
 * Settings, and the library's admin tools.
 *
 * In elite-v2 these were tabs inside a page shared by six sections; here there
 * is one library, so the sharing layer is gone and the tools sit directly on
 * the page. Which tools exist is unchanged.
 */
export default async function SettingsPage(props: {
  searchParams: Promise<{ tab?: string; section?: string }>;
}) {
  const { tab, section } = await props.searchParams;
  const session = await getSession();
  if (!session) redirect("/");

  const profile = ensureUserProfile(Number(session.sub), session.email);
  const isAdmin = session.role === "admin";

  return (
    <SettingsShell
      // The menu's "Library tools" entry links with ?section=library rather
      // than naming a tab, so the set of tabs can change without breaking it.
      tab={tab ?? (section === "library" ? "duplicates" : undefined)}
      isAdmin={isAdmin}
      hasPin={await hasAdultPin()}
      userHome={userHomeDir(Number(session.sub), profile.username)}
    />
  );
}
