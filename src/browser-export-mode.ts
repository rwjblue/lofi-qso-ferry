export type BrowserExportMode =
  | "qrz_fresh_insert"
  | "lotw_fresh_insert"
  | "fresh_inserts"
  | null;

/** Presentation only. Closed common gates take precedence over any mode label. */
export function exportPresentation(enabled: boolean, mode: BrowserExportMode) {
  if (enabled) {
    if (mode === "qrz_fresh_insert")
      return {
        label: "QRZ first inserts",
        message:
          "QRZ first inserts are enabled for the authorized scope after current source verification.",
      };
    if (mode === "lotw_fresh_insert")
      return {
        label: "LoTW first inserts",
        message:
          "LoTW first inserts are enabled for the authorized scope after current source verification.",
      };
    if (mode === "fresh_inserts")
      return {
        label: "QRZ and LoTW first inserts",
        message:
          "QRZ and LoTW first inserts are enabled for the authorized scope after current source verification.",
      };
  }
  return {
    label: "Disabled",
    message:
      "Read-only rollout: production exports are disabled. Connections and history can be reviewed safely.",
  };
}
