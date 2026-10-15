import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useDebouncedValue } from "./useDebouncedValue";

export function SearchInput() {
  const [value, setValue] = useState("");
  const debounced = useDebouncedValue(value, 300);
  const navigate = useNavigate();
  // This component lives in AppShell and never unmounts across navigation. Guard against calling
  // navigate() again for a value we already navigated for — without this, the effect re-firing for
  // any reason other than a genuinely new search term (e.g. a `navigate` identity change on an
  // unrelated re-render) sends the user back to this stale search on every subsequent navigation.
  const lastNavigated = useRef<string | null>(null);

  useEffect(() => {
    const trimmed = debounced.trim();
    if (trimmed && trimmed !== lastNavigated.current) {
      lastNavigated.current = trimmed;
      navigate(`/search?q=${encodeURIComponent(trimmed)}`);
    }
  }, [debounced, navigate]);

  return (
    <div className="shell__search">
      <input type="search" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Search" aria-label="Search" />
    </div>
  );
}
