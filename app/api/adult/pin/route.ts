import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSession, getUserById } from "@/lib/auth";
import { hashPassword, verifyPassword } from "@/lib/password";
import {
  GATE_COOKIE,
  createGateToken,
  gateCookieOptions,
} from "@/lib/adult-gate";

export const dynamic = "force-dynamic";

// Set, change or remove the per-user 18+ PIN (users.adult_pin_hash). The
// settings panel (components/adult-pin-settings.tsx) is the only caller.
// Changing or removing a PIN requires the current one; the same in-memory
// throttle as the unlock route keeps a short PIN from being brute-forced.
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 10 * 60 * 1000;
const failures = new Map<string, { count: number; resetAt: number }>();

function isLockedOut(userId: string): boolean {
  const rec = failures.get(userId);
  return !!rec && Date.now() <= rec.resetAt && rec.count >= MAX_ATTEMPTS;
}
function recordFailure(userId: string) {
  const now = Date.now();
  const rec = failures.get(userId);
  if (!rec || now > rec.resetAt) {
    failures.set(userId, { count: 1, resetAt: now + WINDOW_MS });
  } else {
    rec.count++;
  }
}

type Body = { pin?: unknown; current?: unknown };

async function readBody(request: Request): Promise<{ pin: string; current: string }> {
  const body: Body = await request.json().catch(() => ({}));
  return {
    pin: typeof body.pin === "string" ? body.pin : "",
    current: typeof body.current === "string" ? body.current : "",
  };
}

// A wrong "current" while a hash exists is an attempt against the PIN, so it
// counts toward the same lockout as the unlock route's guesses.
function currentPinOk(
  userId: string,
  storedHash: string | null,
  current: string
): { ok: boolean; response?: NextResponse } {
  if (!storedHash) return { ok: true };
  if (isLockedOut(userId)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Too many attempts. Try again later." },
        { status: 429 }
      ),
    };
  }
  if (!current || !verifyPassword(current, storedHash)) {
    recordFailure(userId);
    return {
      ok: false,
      response: NextResponse.json({ error: "Incorrect current PIN." }, { status: 401 }),
    };
  }
  failures.delete(userId);
  return { ok: true };
}

export async function PUT(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = getUserById(Number(session.sub));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { pin, current } = await readBody(request);
  if (pin.length < 4 || pin.length > 64) {
    return NextResponse.json(
      { error: "PIN must be 4-64 characters." },
      { status: 400 }
    );
  }

  const check = currentPinOk(session.sub, user.adult_pin_hash, current);
  if (!check.ok) return check.response!;

  db.prepare("UPDATE users SET adult_pin_hash = ? WHERE id = ?").run(
    hashPassword(pin),
    user.id
  );

  // Setting the PIN proves the user knows it — mint the unlock cookie in the
  // same response so the account isn't instantly locked out of what it was
  // just looking at.
  const res = NextResponse.json({ hasPin: true });
  res.cookies.set(GATE_COOKIE, await createGateToken(session.sub), gateCookieOptions);
  return res;
}

export async function DELETE(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = getUserById(Number(session.sub));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!user.adult_pin_hash) return NextResponse.json({ hasPin: false });

  const { current } = await readBody(request);
  const check = currentPinOk(session.sub, user.adult_pin_hash, current);
  if (!check.ok) return check.response!;

  db.prepare("UPDATE users SET adult_pin_hash = NULL WHERE id = ?").run(user.id);
  return NextResponse.json({ hasPin: false });
}
