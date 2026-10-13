import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useDebouncedValue } from "./useDebouncedValue";

export function SearchInput() {
  const [value, setValue] = useState("");
  const debounced = useDebouncedValue(value, 300);
  const navigate = useNavigate();

  useEffect(() => {
    if (debounced.trim()) navigate(`/search?q=${encodeURIComponent(debounced.trim())}`);
  }, [debounced, navigate]);

  return (
    <div className="shell__search">
      <input type="search" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Search" aria-label="Search" />
    </div>
  );
}
