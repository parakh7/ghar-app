import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MeDTO } from "@household/shared";
import { ApiError, get, post } from "../../lib/api";

export const meKey = ["me"] as const;

/** Current user + households. `null` when signed out (401 is an expected state, not an error). */
export function useSession() {
  return useQuery({
    queryKey: meKey,
    queryFn: async ({ signal }) => {
      try {
        return (await get<MeDTO>("/auth/me", signal)).data;
      } catch (err) {
        if (err instanceof ApiError && err.code === "UNAUTHENTICATED") return null;
        throw err;
      }
    },
    staleTime: 60_000,
    retry: (count, err) => !(err instanceof ApiError && err.status > 0 && err.status < 500) && count < 2,
  });
}

export function useSignOut() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => post<null>("/auth/logout"),
    onSettled: () => { qc.setQueryData(meKey, null); qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "me" }); },
  });
}
