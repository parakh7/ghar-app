import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CategoryDTO, CreateCategoryInput, MoveCategoryInput, UpdateCategoryInput } from "@household/shared";
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
