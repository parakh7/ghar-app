import type { EmailMessage } from "./email.provider.js";

export function verifyEmailMessage(to: string, name: string, link: string): EmailMessage {
  return {
    to, tag: "verify-email", subject: "Confirm your email",
    text: `Hi ${name},\n\nConfirm your email address to finish setting up your household:\n${link}\n\nThis link expires in 24 hours.`,
  };
}

export function resetPasswordMessage(to: string, name: string, link: string): EmailMessage {
  return {
    to, tag: "reset-password", subject: "Reset your password",
    text: `Hi ${name},\n\nSomeone asked to reset the password for your account. If that was you, choose a new password here:\n${link}\n\nThis link expires in 1 hour. If you didn't ask for this, you can ignore this email — your password won't change.`,
  };
}

export function passwordChangedMessage(to: string, name: string): EmailMessage {
  return {
    to, tag: "password-changed", subject: "Your password was changed",
    text: `Hi ${name},\n\nThe password for your account was just changed and all devices were signed out. If this wasn't you, reset your password immediately.`,
  };
}

export function inviteMessage(to: string, role: string, householdName: string, link: string): EmailMessage {
  return {
    to, tag: "household-invite", subject: `You're invited to join ${householdName} on Ghar`,
    text: `Hi,\n\n${householdName} would like you to join as a ${role.toLowerCase()} on Ghar, the household manager.\n\nAccept the invite:\n${link}\n\nThis link expires in 7 days. If you weren't expecting this, you can ignore this email.`,
  };
}
