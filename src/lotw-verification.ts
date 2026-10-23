import { lotwTrustRoots } from "./lotw-trust.ts";

/** Public verification summaries only; no credentials or vendor requests. */
export interface LotwLoginVerification {
  status: "verified" | "rejected" | "unavailable";
  checkedAt: string;
}

export interface LotwVerificationCheck {
  id: "login" | "certificate" | "trust" | "certificate_status";
  status: "ok" | "warning" | "error" | "unknown";
  message: string;
  checkedAt?: string;
}

const DAY = 24 * 60 * 60 * 1000;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function timestamp(value: unknown): number | undefined {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  )
    return undefined;
  const parsed = Date.parse(value);
  const canonical = value.length === 20 ? `${value.slice(0, -1)}.000Z` : value;
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === canonical
    ? parsed
    : undefined;
}

function checkedAt(value: unknown, now: number): string | undefined {
  const parsed = timestamp(value);
  return parsed !== undefined && parsed <= now
    ? new Date(parsed).toISOString()
    : undefined;
}

function loginCheck(
  config: Record<string, unknown>,
  now: number,
): LotwVerificationCheck {
  if (config.readAccess !== true)
    return {
      id: "login",
      status: "unknown",
      message:
        "LoTW website login is not configured. Add your LoTW username and password to read destination history.",
    };
  const verification = record(config.loginVerification);
  const time = checkedAt(verification.checkedAt, now);
  const date = time ? { checkedAt: time } : {};
  if (verification.status === "verified")
    return {
      id: "login",
      status: "ok",
      message:
        "LoTW website login was accepted at the last check. Use Check login to verify current read access.",
      ...date,
    };
  if (verification.status === "rejected")
    return {
      id: "login",
      status: "error",
      message:
        "LoTW rejected the website login or denied readback access. Check your website username/password and LoTW account access.",
      ...date,
    };
  if (verification.status === "unavailable")
    return {
      id: "login",
      status: "warning",
      message:
        "LoTW website login could not be checked because LoTW was unavailable. Retry Check login.",
      ...date,
    };
  return {
    id: "login",
    status: "warning",
    message:
      "LoTW website credentials were accepted when this connection was saved. The check time is unknown; use Check login to verify current read access.",
  };
}

function certificateCheck(
  certificates: Record<string, unknown>[],
  now: number,
): LotwVerificationCheck {
  if (!certificates.length)
    return {
      id: "certificate",
      status: "unknown",
      message: "No signing certificate has been imported.",
    };
  const dates = certificates.map((certificate) => ({
    from: timestamp(certificate.validFrom),
    to: timestamp(certificate.validTo),
  }));
  if (
    dates.some(
      ({ from, to }) => from === undefined || to === undefined || from > to,
    )
  )
    return {
      id: "certificate",
      status: "error",
      message:
        "Imported certificate dates could not be verified. Import a valid .p12 certificate.",
    };
  if (dates.some(({ to }) => to !== undefined && to <= now))
    return {
      id: "certificate",
      status: "error",
      message:
        "An imported certificate has expired. Renew it in TQSL and import the renewed .p12 file.",
    };
  if (dates.some(({ from }) => from !== undefined && from > now))
    return {
      id: "certificate",
      status: "error",
      message:
        "An imported certificate is not valid yet. Check its validity dates before signing.",
    };
  return {
    id: "certificate",
    status: "ok",
    message:
      "The certificate and matching private key were imported, and the certificate dates are valid. This does not verify a QSO upload.",
  };
}

function trustCheck(
  certificates: Record<string, unknown>[],
  trustRootsJson: string,
): LotwVerificationCheck {
  let roots: string[];
  try {
    roots = lotwTrustRoots(trustRootsJson);
  } catch {
    return {
      id: "trust",
      status: "error",
      message:
        "LoTW certificate trust configuration is invalid on the server. The Ferry operator must repair it before signing.",
    };
  }
  if (!roots.length)
    return {
      id: "trust",
      status: "warning",
      message:
        "LoTW certificate trust is not configured on the server. The Ferry operator must add verified LoTW trust roots before signing.",
    };
  if (!certificates.length)
    return {
      id: "trust",
      status: "unknown",
      message:
        "LoTW server trust roots are configured. Import a certificate to check its issuer.",
    };
  if (certificates.some((certificate) => certificate.trusted !== true))
    return {
      id: "trust",
      status: "warning",
      message:
        "The imported certificate issuer could not be verified. Ferry automatically refreshes ARRL trust roots when a working LoTW website login is available. Check the LoTW login and retry; persistent failures need operator review.",
    };
  return {
    id: "trust",
    status: "ok",
    message:
      "Certificate issuer trust was verified against Ferry's LoTW trust anchors. ARRL roots and saved certificates are rechecked automatically.",
  };
}

function statusCheck(
  certificates: Record<string, unknown>[],
  now: number,
): LotwVerificationCheck {
  if (!certificates.length)
    return {
      id: "certificate_status",
      status: "unknown",
      message: "No imported certificate is available for an ARRL status check.",
    };
  const times = certificates.map((certificate) =>
    checkedAt(certificate.statusCheckedAt, now),
  );
  const oldest = times.every((time): time is string => time !== undefined)
    ? times.toSorted()[0]
    : undefined;
  const date = oldest ? { checkedAt: oldest } : {};
  if (certificates.some((certificate) => certificate.status === "revoked"))
    return {
      id: "certificate_status",
      status: "error",
      message:
        "ARRL reports an imported certificate as revoked. Replace it before signing.",
      ...date,
    };
  if (certificates.some((certificate) => certificate.status === "superseded"))
    return {
      id: "certificate_status",
      status: "error",
      message:
        "ARRL reports an imported certificate as superseded. Import the current certificate before signing.",
      ...date,
    };
  if (certificates.some((certificate) => certificate.status !== "unrevoked"))
    return {
      id: "certificate_status",
      status: "warning",
      message:
        "ARRL certificate status is unknown. Retry certificate verification before signing.",
      ...date,
    };
  if (!oldest)
    return {
      id: "certificate_status",
      status: "warning",
      message:
        "The ARRL certificate status check time is unknown. Recheck status before signing.",
    };
  if (now - Date.parse(oldest) >= DAY)
    return {
      id: "certificate_status",
      status: "warning",
      message:
        "The ARRL certificate status check is at least 24 hours old. Recheck status before signing.",
      ...date,
    };
  return {
    id: "certificate_status",
    status: "ok",
    message:
      "ARRL reported every imported certificate as unrevoked within the last 24 hours. This does not verify a QSO upload.",
    ...date,
  };
}

export function lotwVerification(
  config: Record<string, unknown>,
  options: { trustRootsJson: string; now?: number },
): LotwVerificationCheck[] {
  const now = options.now ?? Date.now();
  const certificates = Array.isArray(config.certificates)
    ? config.certificates.map(record)
    : [];
  return [
    loginCheck(config, now),
    certificateCheck(certificates, now),
    trustCheck(certificates, options.trustRootsJson),
    statusCheck(certificates, now),
  ];
}
