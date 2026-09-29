import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { HouseholdDTO, InviteDTO, InviteMemberInput, MemberDTO, UpdateMemberInput } from "@household/shared";
import { del, get, patch, post } from "../../../lib/api";

export function useHousehold(householdId: string | undefined) {
  return useQuery({
    queryKey: ["household", householdId],
    queryFn: ({ signal }) => get<HouseholdDTO>(`/households/${householdId}`, signal).then((r) => r.data),
    enabled: !!householdId,
  });
}

export function useMembers(householdId: string | undefined) {
  return useQuery({
    queryKey: ["members", householdId],
    queryFn: ({ signal }) => get<MemberDTO[]>(`/households/${householdId}/members`, signal).then((r) => r.data),
    enabled: !!householdId,
  });
}

export function useInvites(householdId: string | undefined) {
  return useQuery({
    queryKey: ["invites", householdId],
    queryFn: ({ signal }) => get<InviteDTO[]>(`/households/${householdId}/invites`, signal).then((r) => r.data),
    enabled: !!householdId,
  });
}

export function useInviteMember(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: InviteMemberInput) => post<InviteDTO>(`/households/${householdId}/invites`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["invites", householdId] }),
  });
}

export function useRevokeInvite(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (inviteId: string) => del<null>(`/households/${householdId}/invites/${inviteId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["invites", householdId] }),
  });
}

export function useResendInvite(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (inviteId: string) => post<InviteDTO>(`/households/${householdId}/invites/${inviteId}/resend`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["invites", householdId] }),
  });
}

export function useUpdateMember(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, body }: { userId: string; body: UpdateMemberInput }) => patch<MemberDTO>(`/households/${householdId}/members/${userId}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["members", householdId] }),
  });
}

export function useRemoveMember(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => del<null>(`/households/${householdId}/members/${userId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["members", householdId] }),
  });
}

export function useLeaveHousehold(householdId: string) {
  return useMutation({ mutationFn: () => del<null>(`/households/${householdId}/members/me`) });
}
