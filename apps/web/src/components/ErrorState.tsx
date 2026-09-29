import { RotateCw } from "lucide-react";
import { Button } from "./Button";

export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="empty" role="alert">
      <p className="empty__title">Couldn't load this</p>
      <p className="empty__text">{message}</p>
      <Button variant="secondary" icon={<RotateCw size={18} aria-hidden />} onClick={onRetry}>Try again</Button>
    </div>
  );
}
