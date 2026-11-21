// The mic button in the composer row: a round conversation.css .pv-cbtn
// beside the main button. A tap starts dictation; while it records, the mic
// grows into the dictation pill (MicPill) in its place.

import { Mic } from "lucide-react";

export interface MicButtonProps {
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}

export function MicButton({ onClick, disabled, title }: MicButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label="Record voice"
      title={title || "Record voice"}
      className="pv-cbtn"
    >
      <Mic aria-hidden="true" />
    </button>
  );
}
