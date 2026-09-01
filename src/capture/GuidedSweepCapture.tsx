/**
 * Batteries-included guided sweep screen: CameraView + useGuidedSweep +
 * a default HUD overlay (tick rail, level bar, status text, thumbnail
 * strip, start/finish/redo controls). Plain react-native styling only —
 * consumers restyle via `accentColor` / `strings`, or replace the whole
 * overlay with `renderHUD`.
 */
import { CameraView, useCameraPermissions } from "expo-camera";
import { useMemo } from "react";
import {
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import {
  SweepStatus,
  type GuidedSweepCaptureProps,
  type GuidedSweepStrings,
} from "./GuidedSweep.types";
import { useScreenInsets } from "./optionalDeps";
import { useGuidedSweep } from "./useGuidedSweep";

const MONO = Platform.select({ ios: "Menlo", default: "monospace" });

const DEFAULT_STRINGS: GuidedSweepStrings = {
  statuses: {
    [SweepStatus.START_TURNING]: "START TURNING",
    [SweepStatus.KEEP_TURNING]: "KEEP TURNING",
    [SweepStatus.SLOW_DOWN]: "SLOW DOWN",
    [SweepStatus.HOLD]: "HOLD STILL…",
    [SweepStatus.LEVEL_THE_PHONE]: "LEVEL THE PHONE",
    [SweepStatus.GO_BACK]: "GO BACK A LITTLE",
  },
  hudTitle: "GUIDED SWEEP",
  hudStats:
    "{count} shots · yaw {yaw}° · next in {next}° · tilt {tilt}° roll {roll}°",
  idleInstructions:
    "Stand in one spot. Press start, hold still a moment, then rotate slowly " +
    "in one direction — photos fire automatically every {stepDeg}°.",
  startButton: "Start sweep",
  cameraStarting: "Camera starting…",
  finishButton: "Finish ({count} shots)",
  redoButton: "Redo",
  useButton: "Use {count} photos",
  cancelButton: "Cancel",
  permissionMessage: "Camera access is needed to capture the sweep.",
  permissionButton: "Grant camera access",
};

const fmt = (template: string, vars: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));

export function GuidedSweepCapture(props: GuidedSweepCaptureProps) {
  const {
    onComplete,
    onCancel,
    accentColor = "#0A84FF",
    minShots = 2,
    strings,
    renderHUD,
    ...sweepOptions
  } = props;

  const insets = useScreenInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const sweep = useGuidedSweep(sweepOptions);
  const {
    phase,
    shots,
    hud,
    start,
    finish,
    cameraRef,
    onCameraReady,
    isCameraReady,
    config,
  } = sweep;

  const S = useMemo<GuidedSweepStrings>(
    () => ({
      ...DEFAULT_STRINGS,
      ...strings,
      statuses: { ...DEFAULT_STRINGS.statuses, ...strings?.statuses },
    }),
    [strings],
  );

  if (!permission) return <View style={styles.root} />;
  if (!permission.granted) {
    return (
      <View style={[styles.root, styles.permission]}>
        <Text style={styles.permissionText}>{S.permissionMessage}</Text>
        <Pressable
          onPress={requestPermission}
          style={({ pressed }) => [
            styles.button,
            { backgroundColor: accentColor, opacity: pressed ? 0.8 : 1 },
          ]}
        >
          <Text style={styles.buttonText}>{S.permissionButton}</Text>
        </Pressable>
        {onCancel && (
          <Pressable onPress={onCancel} hitSlop={12}>
            <Text style={styles.cancelText}>{S.cancelButton}</Text>
          </Pressable>
        )}
      </View>
    );
  }

  const blocked =
    hud.status === SweepStatus.LEVEL_THE_PHONE ||
    hud.status === SweepStatus.GO_BACK;
  // Reconstruct sweep progress (degrees along the locked direction) from
  // the HUD: toTarget = shotCount * stepDeg - progress.
  const progress = shots.length * config.stepDeg - hud.toTargetDeg;

  return (
    <View style={styles.root}>
      {/* Centered 3:4 box — flex:1 would crop the preview to the screen
          aspect while capture keeps the full sensor frame, so the user
          would frame with pixels the photo doesn't show (and vice versa). */}
      <View style={styles.cameraBox}>
        <CameraView
          ref={cameraRef}
          style={styles.camera}
          facing="back"
          animateShutter={false}
          onCameraReady={onCameraReady}
        />
      </View>

      {renderHUD ? (
        renderHUD(sweep)
      ) : (
        <View
          pointerEvents="box-none"
          style={[
            styles.overlay,
            { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 12 },
          ]}
        >
          <View style={styles.header} pointerEvents="box-none">
            <View style={styles.headerText} pointerEvents="none">
              <Text style={[styles.title, { color: accentColor }]}>
                {S.hudTitle}
              </Text>
              <Text style={styles.stats}>
                {fmt(S.hudStats, {
                  count: shots.length,
                  yaw: hud.yawDeg.toFixed(0),
                  next:
                    phase === "sweeping"
                      ? Math.max(0, hud.toTargetDeg).toFixed(0)
                      : "—",
                  tilt: hud.tiltDeg.toFixed(0),
                  roll: hud.rollDeg.toFixed(0),
                })}
              </Text>
            </View>
            {onCancel && (
              <Pressable onPress={onCancel} hitSlop={12}>
                <Text style={styles.cancelText}>{S.cancelButton}</Text>
              </Pressable>
            )}
          </View>

          {phase === "sweeping" && (
            <>
              {/* Yaw rail: fixed center cursor, ticks scroll past it */}
              <View style={styles.rail}>
                <View style={styles.railCursor} />
                {Array.from({ length: config.maxShots }, (_, i) => {
                  const offset = (i * config.stepDeg - progress) * 6; // 6 px per degree
                  if (Math.abs(offset) > 220) return null;
                  const captured = i < shots.length;
                  return (
                    <View
                      key={i}
                      style={[
                        styles.railTick,
                        {
                          marginLeft: offset - 5,
                          backgroundColor: captured
                            ? accentColor
                            : i === shots.length
                              ? "#fff"
                              : "#ffffff55",
                        },
                      ]}
                    />
                  );
                })}
              </View>

              {/* Level bar: roll rotates it, tilt slides it vertically */}
              <View style={styles.levelBox}>
                <View
                  style={[
                    styles.levelBar,
                    {
                      backgroundColor:
                        Math.max(Math.abs(hud.tiltDeg), Math.abs(hud.rollDeg)) >
                        config.tiltWarnDeg
                          ? accentColor
                          : "#ffffffaa",
                      transform: [
                        { translateY: hud.tiltDeg * 3 },
                        { rotate: `${-hud.rollDeg}deg` },
                      ],
                    },
                  ]}
                />
              </View>
            </>
          )}

          <View style={styles.middle} pointerEvents="none">
            {phase === "sweeping" && (
              <Text
                style={[
                  styles.status,
                  { color: blocked ? accentColor : "#fff" },
                ]}
              >
                {S.statuses[hud.status]}
              </Text>
            )}
            {phase === "idle" && (
              <Text style={styles.instructions}>
                {fmt(S.idleInstructions, { stepDeg: config.stepDeg })}
              </Text>
            )}
          </View>

          {/* Bottom controls */}
          <View style={styles.controls}>
            {shots.length > 0 && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <View style={styles.thumbRow}>
                  {shots.map((s) => (
                    <Image
                      key={s.uri}
                      source={{ uri: s.uri }}
                      style={styles.thumb}
                    />
                  ))}
                </View>
              </ScrollView>
            )}
            {phase === "idle" && (
              <Pressable
                onPress={start}
                disabled={!isCameraReady}
                style={({ pressed }) => [
                  styles.button,
                  {
                    backgroundColor: accentColor,
                    opacity: !isCameraReady ? 0.4 : pressed ? 0.8 : 1,
                  },
                ]}
              >
                <Text style={styles.buttonText}>
                  {isCameraReady ? S.startButton : S.cameraStarting}
                </Text>
              </Pressable>
            )}
            {phase === "sweeping" && (
              <Pressable
                onPress={finish}
                style={({ pressed }) => [
                  styles.button,
                  { backgroundColor: "#fff", opacity: pressed ? 0.8 : 1 },
                ]}
              >
                <Text style={[styles.buttonText, { color: "#000" }]}>
                  {fmt(S.finishButton, { count: shots.length })}
                </Text>
              </Pressable>
            )}
            {phase === "done" && (
              <View style={styles.doneRow}>
                <Pressable
                  onPress={start}
                  style={({ pressed }) => [
                    styles.button,
                    styles.doneButton,
                    {
                      backgroundColor: "#ffffff33",
                      opacity: pressed ? 0.6 : 1,
                    },
                  ]}
                >
                  <Text style={styles.buttonText}>{S.redoButton}</Text>
                </Pressable>
                <Pressable
                  onPress={() => onComplete(shots)}
                  disabled={shots.length < minShots}
                  style={({ pressed }) => [
                    styles.button,
                    styles.doneButton,
                    {
                      backgroundColor: accentColor,
                      opacity:
                        shots.length < minShots ? 0.4 : pressed ? 0.8 : 1,
                    },
                  ]}
                >
                  <Text style={styles.buttonText}>
                    {fmt(S.useButton, { count: shots.length })}
                  </Text>
                </Pressable>
              </View>
            )}
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  permission: {
    justifyContent: "center",
    alignItems: "center",
    gap: 16,
    padding: 24,
  },
  permissionText: { fontSize: 15, color: "#fff", textAlign: "center" },
  cameraBox: { flex: 1, justifyContent: "center" },
  camera: { width: "100%", aspectRatio: 3 / 4 },
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 16,
  },
  header: { flexDirection: "row", alignItems: "flex-start" },
  headerText: { flex: 1 },
  title: { fontFamily: MONO, fontSize: 12 },
  stats: { fontFamily: MONO, fontSize: 12, color: "#ffffffcc" },
  cancelText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#ffffffcc",
    textShadowColor: "#000",
    textShadowRadius: 4,
  },
  rail: {
    marginTop: 24,
    height: 56,
    justifyContent: "center",
    overflow: "hidden",
  },
  railCursor: {
    position: "absolute",
    left: "50%",
    width: 2,
    height: 44,
    marginLeft: -1,
    backgroundColor: "#fff",
    borderRadius: 1,
  },
  railTick: {
    position: "absolute",
    left: "50%",
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  levelBox: { alignItems: "center", marginTop: 12 },
  levelBar: { width: 140, height: 3, borderRadius: 2 },
  middle: { flex: 1, justifyContent: "center", alignItems: "center", gap: 8 },
  status: {
    fontFamily: MONO,
    fontSize: 24,
    fontWeight: "700",
    textAlign: "center",
    textShadowColor: "#000",
    textShadowRadius: 8,
  },
  instructions: {
    fontSize: 15,
    color: "#fff",
    textAlign: "center",
    textShadowColor: "#000",
    textShadowRadius: 6,
  },
  controls: { gap: 10 },
  thumbRow: { flexDirection: "row", gap: 6 },
  thumb: { width: 54, height: 72, borderRadius: 6 },
  button: { borderRadius: 12, padding: 14, alignItems: "center" },
  buttonText: { fontSize: 15, fontWeight: "600", color: "#fff" },
  doneRow: { flexDirection: "row", gap: 10 },
  doneButton: { flex: 1 },
});
