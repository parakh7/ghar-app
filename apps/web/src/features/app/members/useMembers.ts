import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { HouseholdDTO, InviteDTO, InviteMemberInput, InviteWithLinkDTO, MemberDTO, UpdateMemberInput } from "@household/shared";
import { del, get, patch, post } from "../../../lib/api";
import { meKey } from "../../auth/session";

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
    mutationFn: (body: InviteMemberInput) => post<InviteWithLinkDTO>(`/households/${householdId}/invites`, body),
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
    mutationFn: (inviteId: string) => post<InviteWithLinkDTO>(`/households/${householdId}/invites/${inviteId}/resend`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["invites", householdId] }),
  });
}

/**
 * A role/remove/leave mutation can change three cached things at once: the members list, the
 * household summary (permissions, memberCount — used to gate the manage UI), and the session
 * (memberCount shown elsewhere). All three must be invalidated or the UI can show stale state
 * until an unrelated remount (e.g. demoting yourself from OWNER but manage controls stay visible).
 */
function invalidateMemberQueries(qc: ReturnType<typeof useQueryClient>, householdId: string) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: ["members", householdId] }),
    qc.invalidateQueries({ queryKey: ["household", householdId] }),
    qc.invalidateQueries({ queryKey: meKey }),
  ]);
}

export function useUpdateMember(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, body }: { userId: string; body: UpdateMemberInput }) => patch<MemberDTO>(`/households/${householdId}/members/${userId}`, body),
    onSuccess: () => invalidateMemberQueries(qc, householdId),
  });
}

export function useRemoveMember(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => del<null>(`/households/${householdId}/members/${userId}`),
    onSuccess: () => invalidateMemberQueries(qc, householdId),
  });
}

export function useLeaveHousehold(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => del<null>(`/households/${householdId}/members/me`),
    onSuccess: () => qc.invalidateQueries({ queryKey: meKey }),
  });
}
