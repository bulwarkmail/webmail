"use client";

import { useSettingsStore } from "@/stores/settings-store";
import { usePolicyStore } from "@/stores/policy-store";
import { useDeviceDetection } from "@/hooks/use-media-query";
import { useDrawnMailLayout } from "@/hooks/use-effective-mail-layout";
import { effectiveReturnToList, listBesideReader, returnToListSetByPolicy } from "@/lib/return-to-list";

/**
 * The "Return to list after…" switch as it applies on this device and in this
 * layout (lib/return-to-list), and whether that comes from the layout because
 * nobody has set it yet.
 */
export function useReturnToListAfterAction(): { checked: boolean; followsLayout: boolean } {
  const { isMobile } = useDeviceDetection();
  const value = useSettingsStore((s) => s.returnToListAfterAction);
  const explicitSettings = useSettingsStore((s) => s.explicitSettings);
  const mailLayout = useDrawnMailLayout();
  const interfaceLayout = useSettingsStore((s) => s.interfaceLayout);
  const simpleMode = useSettingsStore((s) => s.simpleMode);
  // Re-read when the policy arrives or changes.
  usePolicyStore((s) => s.policy);
  const policySet = returnToListSetByPolicy();
  const besideReader = listBesideReader({ mailLayout, interfaceLayout, simpleMode, isMobile });
  return {
    checked: effectiveReturnToList({ returnToListAfterAction: value, explicitSettings }, besideReader, policySet),
    followsLayout: !policySet && !explicitSettings.includes("returnToListAfterAction"),
  };
}
