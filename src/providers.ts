/** Browser-safe provider metadata. Credentials and protocol code belong in adapters. */
export const providerDefinitions = {
  lofi: {
    name: "LoFi",
    role: "source",
    capabilities: {
      readback: false,
      templates: false,
      confirmation: false,
      submissionOnly: false,
      corrections: false,
    },
  },
  qrz: {
    name: "QRZ Logbook",
    role: "destination",
    capabilities: {
      readback: true,
      templates: true,
      confirmation: false,
      submissionOnly: false,
      corrections: "guarded_replace",
    },
  },
  lotw: {
    name: "LoTW",
    role: "destination",
    capabilities: {
      readback: true,
      templates: false,
      confirmation: true,
      submissionOnly: true,
      corrections: "append",
    },
  },
  clublog: {
    name: "Club Log",
    role: "destination",
    capabilities: {
      readback: true,
      templates: false,
      confirmation: false,
      submissionOnly: false,
      corrections: "changed_identity",
    },
  },
} as const;

export type ProviderKind = keyof typeof providerDefinitions;
export type DestinationKind = {
  [Kind in ProviderKind]: (typeof providerDefinitions)[Kind]["role"] extends "destination"
    ? Kind
    : never;
}[ProviderKind];
export const providerKinds = Object.keys(providerDefinitions) as ProviderKind[];
export const vendorKinds = providerKinds;
export const destinationKinds = providerKinds.filter(isDestinationKind);

export function isProviderKind(kind: string): kind is ProviderKind {
  return Object.hasOwn(providerDefinitions, kind);
}
export function isDestinationKind(kind: string): kind is DestinationKind {
  return (
    isProviderKind(kind) && providerDefinitions[kind].role === "destination"
  );
}
export function providerName(kind: string): string {
  return isProviderKind(kind) ? providerDefinitions[kind].name : kind;
}
