import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CategoryDTO, CreateCategoryInput, CreateHousehelpInput, HousehelpDTO, MoveCategoryInput, UpdateCategoryInput, UpdateHousehelpInput } from "@household/shared";
import { del, get, patch, post } from "../../../lib/api";

export function useCategories(householdId: string | undefined) {
  return useQuery({
    queryKey: ["categories", householdId],
    queryFn: ({ signal }) => get<CategoryDTO[]>(`/households/${householdId}/categories`, signal).then((r) => r.data),
    enabled: !!householdId,
  });
}

export function useCreateCategory(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateCategoryInput) => post<CategoryDTO>(`/households/${householdId}/categories`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["categories", householdId] }),
  });
}

export function useUpdateCategory(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ categoryId, body }: { categoryId: string; body: UpdateCategoryInput }) => patch<CategoryDTO>(`/households/${householdId}/categories/${categoryId}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["categories", householdId] }),
  });
}

export function useDeleteCategory(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (categoryId: string) => del<null>(`/households/${householdId}/categories/${categoryId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["categories", householdId] }),
  });
}

export function useMoveCategory(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ categoryId, direction }: { categoryId: string; direction: MoveCategoryInput["direction"] }) =>
      post<null>(`/households/${householdId}/categories/${categoryId}/move`, { direction }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["categories", householdId] }),
  });
}

export function useHousehelps(householdId: string | undefined, includeArchived: boolean) {
  return useQuery({
    queryKey: ["househelps", householdId, includeArchived],
    queryFn: ({ signal }) => get<HousehelpDTO[]>(`/households/${householdId}/househelps${includeArchived ? "?includeArchived=true" : ""}`, signal).then((r) => r.data),
    enabled: !!householdId,
  });
}

export function useHousehelp(householdId: string | undefined, id: string | undefined) {
  return useQuery({
    queryKey: ["househelp", householdId, id],
    queryFn: ({ signal }) => get<HousehelpDTO>(`/households/${householdId}/househelps/${id}`, signal).then((r) => r.data),
    enabled: !!householdId && !!id,
  });
}

function invalidateHousehelpQueries(qc: ReturnType<typeof useQueryClient>, householdId: string, id?: string) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: ["househelps", householdId] }),
    ...(id ? [qc.invalidateQueries({ queryKey: ["househelp", householdId, id] })] : []),
  ]);
}

export function useCreateHousehelp(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateHousehelpInput) => post<HousehelpDTO>(`/households/${householdId}/househelps`, body),
    onSuccess: () => invalidateHousehelpQueries(qc, householdId),
  });
}

export function useUpdateHousehelp(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateHousehelpInput }) => patch<HousehelpDTO>(`/households/${householdId}/househelps/${id}`, body),
    onSuccess: (_data, { id }) => invalidateHousehelpQueries(qc, householdId, id),
  });
}

export function useArchiveHousehelp(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => post<null>(`/households/${householdId}/househelps/${id}/archive`),
    onSuccess: (_data, id) => invalidateHousehelpQueries(qc, householdId, id),
  });
}

export function useUnarchiveHousehelp(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => post<null>(`/households/${householdId}/househelps/${id}/unarchive`),
    onSuccess: (_data, id) => invalidateHousehelpQueries(qc, householdId, id),
  });
}
