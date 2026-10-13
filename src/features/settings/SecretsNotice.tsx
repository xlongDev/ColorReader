import { useSecretsStatus } from "@/hooks/useSystemInfo";
import { isDesktopRuntime } from "@/lib/ipc";

/**
 * The line that says credentials are not being encrypted on this machine.
 *
 * Shown only when something is actually wrong, for the same reason the update
 * banner is: a line that is always there is a line nobody reads. But it has to
 * be somewhere a reader will find it, because "saved, but in the clear on disk"
 * is invisible from the field they just typed into — and it is the one thing
 * about this feature they cannot discover by using it.
 *
 * The sentence is the backend's, shown verbatim: it is the only side that knows
 * whether the credential store is missing or the credentials in it are
 * unopenable, and the two ask the reader for different things.
 */
export function SecretsNotice() {
  const status = useSecretsStatus();
  // The browser build answers `available: false` too, and truthfully — it has no
  // credential store. It also has nothing to store, so a warning there would be
  // about a problem that build does not have.
  if (!isDesktopRuntime || !status.data || status.data.available) return null;
  return (
    <div data-secrets-notice className="px-5 py-3.5">
      <output className="text-danger text-[12.5px] leading-relaxed">{status.data.detail}</output>
    </div>
  );
}
