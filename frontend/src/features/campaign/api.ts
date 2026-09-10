import { apiFetch } from "@/lib/api-client";

export interface CampaignView {
  code: string;
  title: string;
  subtitle?: string;
  status: "draft" | "open" | "closed";
  closes_at?: string;
  gift_label: string;
  gift_detail?: string;
  gifts: number;
  chances: number;
  gifts_left: number;
  chances_left: number;
  played: number;
  questions: number;
  prizes: string[];
  seed_hash?: string;
  seed?: string;
  telegram?: string;
  phone?: string;
}

export interface CampaignEntry {
  token?: string;
  full_name: string;
  clinic_name: string;
  quiz_done: boolean;
  spun: boolean;
  won: boolean;
  prize_label?: string;
  spun_at?: string;
}

export interface CampaignQuestion {
  id: string;
  prompt: string;
  choices: string[];
  answered: boolean;
}

export interface AnswerResult {
  correct: boolean;
  explain?: string;
  teaches?: string;
  quiz_done: boolean;
}

export interface SpinResult {
  won: boolean;
  prize_label: string;
  detail?: string;
  slot_index: number;
  waiting: boolean;
}

/** The clinic's token travels in a header, never the URL — a campaign link gets
 *  pasted into group chats, and a link that carries someone's place in the draw
 *  would hand it to whoever reads the chat. */
const as = (token: string) => ({ headers: { "X-Campaign-Token": token }, auth: false as const });

export const getCampaign = (code: string) => apiFetch<CampaignView>(`/campaigns/${code}`, { auth: false });

export const enterCampaign = (code: string, body: { full_name: string; phone: string; clinic_name: string; website?: string }) =>
  apiFetch<CampaignEntry>(`/campaigns/${code}/enter`, { method: "POST", body, auth: false });

export const resumeCampaign = (code: string, token: string) =>
  apiFetch<CampaignEntry>(`/campaigns/${code}/me`, as(token));

export const campaignQuestions = (code: string, token: string) =>
  apiFetch<CampaignQuestion[]>(`/campaigns/${code}/questions`, as(token));

export const answerQuestion = (code: string, token: string, question: string, choice: number) =>
  apiFetch<AnswerResult>(`/campaigns/${code}/answer`, { method: "POST", body: { question, choice }, ...as(token) });

export const spinWheel = (code: string, token: string) =>
  apiFetch<SpinResult>(`/campaigns/${code}/spin`, { method: "POST", ...as(token) });

export interface SignupBody {
  owner_name: string;
  phone: string;
  clinic_name: string;
  location: string;
  structure: string;
  facilities: string[];
  website?: string;
}

/** The interest form. No token: the clinic has nothing yet. */
export const signUp = (code: string, body: SignupBody) =>
  apiFetch<{ ok: boolean }>(`/campaigns/${code}/signup`, { method: "POST", body, auth: false });

/**
 * How a phone number should read, and how it should dial.
 *
 * The two are not the same: "+251 95 500 8081" is what a person recognises, and
 * "+251955008081" is what belongs in a tel: link. Storing the readable form and
 * hoping the browser copes is how you get a number that cannot be tapped.
 */
export function dialLabel(raw: string): string {
  const d = raw.replace(/[^\d+]/g, "");
  if (/^\+251\d{9}$/.test(d)) return `+251 ${d.slice(4, 6)} ${d.slice(6, 9)} ${d.slice(9)}`;
  if (/^0\d{9}$/.test(d)) return `${d.slice(0, 4)} ${d.slice(4, 6)} ${d.slice(6, 8)} ${d.slice(8)}`;
  return raw;
}
export const dialHref = (raw: string) => `tel:${raw.replace(/[^\d+]/g, "")}`;
