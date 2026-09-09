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
