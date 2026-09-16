"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { cn } from "@/lib/utils";
import PostsImportButton from "@/components/posts-import-button";
import PostsDuplicates from "@/components/posts-duplicates";
import PostsCleanup from "@/components/posts-cleanup";
import InstagramAutoConnect from "@/components/instagram-auto-connect";
import TiktokAutoConnect from "@/components/tiktok-auto-connect";
import LinkProfiles from "@/components/link-profiles";
import UnifiedMergeProfiles from "@/components/unified-merge-profiles";
import AdultPinSettings from "@/components/adult-pin-settings";
import JobsManager from "@/components/jobs-manager";

const TABS = [
  { key: "import", label: "Import", adminOnly: false },
  { key: "duplicates", label: "Duplicates", adminOnly: false },
  { key: "cleaning", label: "Cleaning", adminOnly: false },
  { key: "profiles", label: "Profiles", adminOnly: true },
  { key: "sources", label: "Sources", adminOnly: true },
  { key: "adult", label: "18+ access", adminOnly: false },
  { key: "jobs", label: "Background jobs", adminOnly: true },
] as const;

type TabKey = (typeof TABS)[number]["key"];

function Card({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-2xl bg-white/5 p-4 ring-1 ring-white/10">
      {children}
    </section>
  );
}

function Panel({
  tab,
  isAdmin,
  hasPin,
  userHome,
}: {
  tab: TabKey;
  isAdmin: boolean;
  hasPin: boolean;
  userHome: string;
}) {
  if (tab === "import") {
    return (
      <div className="flex flex-col gap-6">
        <Card>
          <h2 className="text-base font-medium">Your own uploads</h2>
          <p className="mt-1 text-sm text-white/50">
            Anything you post yourself is filed under your own folder in the
            library:
          </p>
          <code className="mt-2 block rounded-lg bg-white/5 px-3 py-2 text-xs text-white/70">
            {userHome}/posts/
          </code>
        </Card>
        {isAdmin && (
          <Card>
            <h2 className="text-base font-medium">Shared creator folder</h2>
            <p className="mb-2 mt-1 text-sm text-white/50">
              Drop files here and they are sorted onto creator profiles:
            </p>
            <code className="mb-3 block rounded-lg bg-white/5 px-3 py-2 text-xs text-white/70">
              _import/
            </code>
            <p className="mb-3 text-sm text-white/50">
              A subfolder named after the creator imports everything inside it.
              Loose files work too, as{" "}
              <code className="text-white/70">creator_-_title.jpg</code> or{" "}
              <code className="text-white/70">creator-YYYYMMDD-0001.jpg</code>;
              same-day files from one creator become one carousel.
            </p>
            <p className="mb-3 text-sm text-white/50">
              A drop is picked up on its own within fifteen minutes. The button
              is only for when you do not want to wait.
            </p>
            <PostsImportButton />
          </Card>
        )}
      </div>
    );
  }
  if (tab === "duplicates") return <PostsDuplicates />;
  if (tab === "cleaning") return <PostsCleanup />;
  if (tab === "profiles" && isAdmin) {
    return (
      <div className="flex flex-col gap-6">
        <LinkProfiles />
        <UnifiedMergeProfiles />
      </div>
    );
  }
  if (tab === "sources" && isAdmin) {
    return (
      <div className="flex flex-col gap-6">
        <Card>
          <h2 className="text-base font-medium">Instagram</h2>
          <p className="mb-3 mt-1 text-sm text-white/50">
            Connect an Instagram account on a person&apos;s profile (Edit
            profile → Instagram) and use &ldquo;Sync from Instagram&rdquo;
            there. Or auto-connect every creator folder whose name is a real
            Instagram account — only exact, verified matches are linked:
          </p>
          <InstagramAutoConnect />
        </Card>
        <Card>
          <h2 className="text-base font-medium">TikTok</h2>
          <p className="mb-3 mt-1 text-sm text-white/50">
            Connect a TikTok handle on a person&apos;s profile (Edit profile →
            TikTok) and sync there — no cookie required for public accounts. Or
            auto-connect every creator folder whose name is a real TikTok
            account:
          </p>
          <TiktokAutoConnect />
        </Card>
      </div>
    );
  }
  if (tab === "adult") return <AdultPinSettings hasPin={hasPin} />;
  if (tab === "jobs" && isAdmin) return <JobsManager />;
  return null;
}

function Shell({
  tab,
  isAdmin,
  hasPin,
  userHome,
}: {
  tab?: string;
  isAdmin: boolean;
  hasPin: boolean;
  userHome: string;
}) {
  const pathname = usePathname();
  const params = useSearchParams();
  const visible = TABS.filter((t) => isAdmin || !t.adminOnly);
  const requested = (tab ?? params.get("tab")) as TabKey | null;
  const active: TabKey =
    requested && visible.some((t) => t.key === requested)
      ? requested
      : visible[0].key;

  return (
    <div className="mx-auto max-w-3xl px-3 pb-24 pt-6 text-white">
      <h1 className="mb-4 px-1 text-lg font-semibold">Settings</h1>
      <div className="mb-5 flex gap-1.5 overflow-x-auto pb-1">
        {visible.map((t) => (
          <Link
            key={t.key}
            href={`${pathname}?tab=${t.key}`}
            className={cn(
              "shrink-0 rounded-full px-3.5 py-1.5 text-sm transition",
              t.key === active
                ? "bg-violet-500 font-semibold text-white"
                : "bg-white/5 text-white/60 hover:text-white/90"
            )}
          >
            {t.label}
          </Link>
        ))}
      </div>
      <Panel
        tab={active}
        isAdmin={isAdmin}
        hasPin={hasPin}
        userHome={userHome}
      />
    </div>
  );
}

export default function SettingsShell({
  tab,
  isAdmin,
  hasPin,
  userHome,
}: {
  tab?: string;
  isAdmin: boolean;
  hasPin: boolean;
  userHome: string;
}) {
  // useSearchParams needs a boundary; the server already knows the tab, so the
  // fallback is only ever a frame long.
  return (
    <Suspense fallback={null}>
      <Shell
        tab={tab}
        isAdmin={isAdmin}
        hasPin={hasPin}
        userHome={userHome}
      />
    </Suspense>
  );
}
