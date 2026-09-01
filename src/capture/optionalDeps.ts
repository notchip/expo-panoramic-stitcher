/**
 * Optional peer dependencies, feature-detected at module load.
 *
 * The requires are literal and wrapped in try/catch so Metro treats
 * them as optional dependencies (expo's default metro config enables
 * `transformer.allowOptionalDependencies`): a missing package neither
 * fails the consumer's bundle nor throws at runtime. Do NOT convert
 * these to static `import` — that would make the packages hard
 * requirements again.
 */

// `require` exists at runtime under Metro; our tsconfig restricts
// ambient @types (types: ["jest"]) so declare the minimal shape here.
declare const require: (moduleId: string) => unknown;

// ---------------------------------------------------------------------------
// expo-haptics (optional peer): shutter feedback. Missing → silent no-op.

type HapticsModule = {
  notificationAsync: (type: unknown) => Promise<unknown>;
  NotificationFeedbackType: { Success: unknown };
};

let Haptics: HapticsModule | null = null;
try {
  Haptics = require("expo-haptics") as HapticsModule;
} catch {
  Haptics = null;
}

/** Fire the capture-success haptic if expo-haptics is installed; never throws. */
export function hapticShotFeedback(): void {
  if (!Haptics) return;
  try {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).then(
      () => undefined,
      () => undefined,
    );
  } catch {
    // Haptics are strictly best-effort.
  }
}

// ---------------------------------------------------------------------------
// react-native-safe-area-context (optional peer): HUD edge padding.
// Nearly every Expo app ships it (expo-router requires it); without it —
// or without a <SafeAreaProvider> above us — fall back to fixed padding
// that clears a status bar but may not clear every notch.

export type ScreenInsets = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

const FALLBACK_INSETS: ScreenInsets = {
  top: 24,
  right: 0,
  bottom: 16,
  left: 0,
};

let realUseSafeAreaInsets: (() => ScreenInsets) | null = null;
try {
  realUseSafeAreaInsets = (
    require("react-native-safe-area-context") as {
      useSafeAreaInsets: () => ScreenInsets;
    }
  ).useSafeAreaInsets;
} catch {
  realUseSafeAreaInsets = null;
}

/**
 * `useSafeAreaInsets` when available, fixed fallback insets otherwise.
 * The branch is constant for the life of the app (module-load feature
 * detection), so the hook call order is stable across renders.
 */
export function useScreenInsets(): ScreenInsets {
  if (!realUseSafeAreaInsets) return FALLBACK_INSETS;
  try {
    return realUseSafeAreaInsets();
  } catch {
    // Library present but no <SafeAreaProvider> mounted above us.
    return FALLBACK_INSETS;
  }
}
