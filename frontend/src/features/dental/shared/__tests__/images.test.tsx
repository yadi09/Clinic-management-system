// Images kept against a dental visit: the Before / After / X-ray tabs, uploading
// (compressed first, filed under the open tab), the per-session cap, deleting with
// a confirmation, and the full-screen viewer.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ uploadDentalImage: vi.fn(), deleteDentalImage: vi.fn() }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const img = vi.hoisted(() => ({ compressImage: vi.fn() }));
vi.mock("@/features/dental/api", async (orig) => ({ ...(await orig<object>()), ...api }));
vi.mock("@/lib/image", async (orig) => ({ ...(await orig<object>()), ...img }));
vi.mock("sonner", async (orig) => ({ ...(await orig<object>()), toast }));
vi.mock("@/lib/api-client", async (orig) => {
  const { quietApiFetch } = await import("@/test/render");
  return { ...(await orig<object>()), apiFetch: vi.fn(quietApiFetch) };
});
vi.mock("@/app/auth-context", () => ({
  useAuth: () => ({ can: () => true, flagOn: () => true, user: { id: "u1", full_name: "Dr Test" }, activeBranchId: null }),
}));

import { ImageGallery, MAX_SESSION_IMAGES, SessionImages } from "@/features/dental/shared/visitRecord";
import { AppError } from "@/lib/api-client";
import type { DentalImage, Session } from "@/features/dental/api";
import { renderUI } from "@/test/render";
import { S } from "../../visit/__tests__/fixtures";

const T = "2026-08-12";
const IM = (id: string, category?: string): DentalImage =>
  ({ id, url: `https://cdn/${id}.jpg`, filename: `${id}.jpg`, mime_type: "image/jpeg", size_bytes: 1, created_at: "", category }) as DentalImage;
const file = (name: string) => new File(["x"], name, { type: "image/jpeg" });

function images(session: Session, { editable = true, imageLimit = -1 } = {}) {
  const onChanged = vi.fn();
  const r = renderUI(<SessionImages patientId="pat_1" session={session} editable={editable} imageLimit={imageLimit} onChanged={onChanged} />);
  return { ...r, onChanged };
}
const fileInputs = () => Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]'));
const pick = (files: File[]) => fireEvent.change(fileInputs()[0], { target: { files } });
const tab = (name: RegExp) => screen.getByRole("tab", { name });

describe("REG-FE-IMAGES images on a dental visit", () => {
  beforeEach(() => {
    Object.values(api).forEach((f) => { f.mockReset(); f.mockResolvedValue({}); });
    Object.values(toast).forEach((f) => f.mockReset());
    img.compressImage.mockReset();
    img.compressImage.mockImplementation(async (f: File) => new File(["c"], `small-${f.name}`, { type: "image/jpeg" }));
  });
  afterEach(() => vi.useRealTimers());

  test("REG-FE-IMAGES-001 opens on Before with per-tab counts, and an empty Before tab invites an upload", () => {
    images(S("s1", T, 1, "planned", { images: [IM("a", "after"), IM("x1", "xray"), IM("x2", "xray")] }));
    expect(tab(/Before/)).toHaveAttribute("aria-selected", "true");
    expect(tab(/Before/)).toHaveTextContent("Before0");
    expect(tab(/After/)).toHaveTextContent("After1");
    expect(tab(/X-ray/)).toHaveTextContent("X-ray2");
    expect(tab(/All/)).toHaveTextContent("All3");
    expect(screen.getByText("No before images yet")).toBeInTheDocument();
    expect(screen.getByText(/Photograph the before state/)).toBeInTheDocument();
    // The header's small button and the empty slot's large one.
    expect(screen.getAllByText("Add before")).toHaveLength(2);
  });

  test("REG-FE-IMAGES-002 each tab shows only its own images; All shows every image and offers no upload", async () => {
    const { user } = images(S("s1", T, 1, "planned", { images: [IM("b1", "before"), IM("a1", "after"), IM("x1", "xray")] }));
    expect(screen.getAllByRole("img").map((i) => i.getAttribute("alt"))).toEqual(["b1.jpg"]);
    await user.click(tab(/X-ray/));
    expect(screen.getAllByRole("img").map((i) => i.getAttribute("alt"))).toEqual(["x1.jpg"]);
    expect(screen.getByText("Add x-ray")).toBeInTheDocument();
    await user.click(tab(/All/));
    expect(screen.getAllByRole("img")).toHaveLength(3);
    expect(fileInputs()).toHaveLength(0);
  });

  test("REG-FE-IMAGES-003 All with no images says how to add one", async () => {
    const { user } = images(S("s1", T, 1));
    await user.click(tab(/All/));
    expect(screen.getByText("No images for this visit")).toBeInTheDocument();
    expect(screen.getByText("Pick Before, After or X-ray to add one.")).toBeInTheDocument();
  });

  test("REG-FE-IMAGES-004 uploading compresses each file and files it under the open tab, then says how many", async () => {
    const { user, onChanged } = images(S("s1", T, 1));
    await user.click(tab(/X-ray/));
    pick([file("one.png"), file("two.png")]);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("2 x-ray images added"));
    expect(img.compressImage).toHaveBeenCalledTimes(2);
    expect(img.compressImage.mock.calls[0][1]).toEqual({ maxEdge: 2000, quality: 0.8 });
    expect(api.uploadDentalImage).toHaveBeenCalledTimes(2);
    const [pid, uploaded, sid, cat] = api.uploadDentalImage.mock.calls[0];
    expect([pid, (uploaded as File).name, sid, cat]).toEqual(["pat_1", "small-one.png", "s1", "xray"]);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  test("REG-FE-IMAGES-005 one image reads in the singular", async () => {
    images(S("s1", T, 1));
    pick([file("one.png")]);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("1 before image added"));
    expect(api.uploadDentalImage.mock.calls[0][3]).toBe("before");
  });

  test("REG-FE-IMAGES-006 a refused upload stops the batch with the server's reason, and nothing is reported added", async () => {
    api.uploadDentalImage.mockRejectedValueOnce(new AppError(413, "QUOTA", "Storage quota reached"));
    const { onChanged } = images(S("s1", T, 1));
    pick([file("one.png"), file("two.png")]);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Storage quota reached"));
    expect(api.uploadDentalImage).toHaveBeenCalledTimes(1);
    expect(toast.success).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  test("REG-FE-IMAGES-007 a failure part-way names the file, and the ones already uploaded are still reported", async () => {
    api.uploadDentalImage.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("network"));
    const { onChanged } = images(S("s1", T, 1));
    pick([file("one.png"), file("two.png"), file("three.png")]);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not upload two.png"));
    expect(api.uploadDentalImage).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("1 before image added"));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  test("REG-FE-IMAGES-008 a compression failure is reported the same way and nothing is uploaded", async () => {
    img.compressImage.mockRejectedValueOnce(new Error("decode"));
    images(S("s1", T, 1));
    pick([file("bad.heic")]);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not upload bad.heic"));
    expect(api.uploadDentalImage).not.toHaveBeenCalled();
  });

  test("REG-FE-IMAGES-009 while uploading the button says so and cannot be used again", async () => {
    let resolve!: () => void;
    api.uploadDentalImage.mockReturnValue(new Promise<void>((r) => { resolve = r; }));
    images(S("s1", T, 1));
    pick([file("one.png")]);
    await waitFor(() => expect(screen.getAllByText("Uploading…")).toHaveLength(2));
    fileInputs().forEach((i) => expect(i).toBeDisabled());
    resolve();
    // Done: both buttons (header and empty slot) are back and usable.
    await waitFor(() => expect(screen.getAllByText("Add before")).toHaveLength(2));
    fileInputs().forEach((i) => expect(i).toBeEnabled());
  });

  test("REG-FE-IMAGES-010 choosing no file does nothing", () => {
    images(S("s1", T, 1));
    pick([]);
    expect(img.compressImage).not.toHaveBeenCalled();
    expect(api.uploadDentalImage).not.toHaveBeenCalled();
  });

  test("REG-FE-IMAGES-011 at the plan's image limit the upload is disabled", () => {
    images(S("s1", T, 1, "planned", { images: [IM("a", "after"), IM("b", "after")] }), { imageLimit: 2 });
    fileInputs().forEach((i) => expect(i).toBeDisabled());
  });

  test("REG-FE-IMAGES-012 with no plan limit, the session's own cap of 12 applies", () => {
    expect(MAX_SESSION_IMAGES).toBe(12);
    const eleven = Array.from({ length: 11 }, (_, i) => IM(`i${i}`, "after"));
    const { unmount } = images(S("s1", T, 1, "planned", { images: eleven }), { imageLimit: -1 });
    fileInputs().forEach((i) => expect(i).toBeEnabled());
    unmount();
    images(S("s1", T, 1, "planned", { images: [...eleven, IM("i11", "after")] }), { imageLimit: 0 });
    fileInputs().forEach((i) => expect(i).toBeDisabled());
  });

  test("REG-FE-IMAGES-013 read-only: no upload and no delete", () => {
    images(S("s1", T, 1, "done", { images: [IM("b1", "before")] }), { editable: false });
    expect(fileInputs()).toHaveLength(0);
    expect(screen.queryByText(/^Add /)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove image" })).not.toBeInTheDocument();
  });

  test("REG-FE-IMAGES-014 deleting from a thumbnail asks first, then removes it and refreshes", async () => {
    const { user, onChanged } = images(S("s1", T, 1, "planned", { images: [IM("b1", "before")] }));
    await user.click(screen.getByRole("button", { name: "Remove image" }));
    const dlg = await screen.findByRole("dialog");
    expect(within(dlg).getByText("Delete this image?")).toBeInTheDocument();
    expect(within(dlg).getByRole("img")).toHaveAttribute("src", "https://cdn/b1.jpg");
    await user.click(within(dlg).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.deleteDentalImage).toHaveBeenCalledWith("pat_1", "b1"));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Image removed"));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  test("REG-FE-IMAGES-015 Cancel on the delete confirmation keeps the image", async () => {
    const { user } = images(S("s1", T, 1, "planned", { images: [IM("b1", "before")] }));
    await user.click(screen.getByRole("button", { name: "Remove image" }));
    const dlg = await screen.findByRole("dialog");
    await user.click(within(dlg).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.deleteDentalImage).not.toHaveBeenCalled();
  });

  test("REG-FE-IMAGES-016 a failed delete says why (or a fallback) and does not refresh", async () => {
    api.deleteDentalImage.mockRejectedValueOnce(new AppError(403, "F", "Not allowed")).mockRejectedValueOnce(new Error("x"));
    const { user, onChanged } = images(S("s1", T, 1, "planned", { images: [IM("b1", "before")] }));
    for (const msg of ["Not allowed", "Could not remove the image"]) {
      await user.click(screen.getByRole("button", { name: "Remove image" }));
      await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete" }));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(msg));
    }
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe("REG-FE-IMAGES the image viewer", () => {
  const three = [IM("b1", "before"), IM("x1", "xray"), IM("u1")];
  function gallery(imgs = three, editable = true) {
    const onDelete = vi.fn();
    const r = renderUI(<ImageGallery images={imgs} editable={editable} onDelete={onDelete} />);
    return { ...r, onDelete };
  }
  const title = () => screen.getByRole("dialog").querySelector("h2")!;

  test("REG-FE-IMAGES-017 a thumbnail opens the viewer on that image, with its type and position", async () => {
    const { user } = gallery();
    await user.click(screen.getAllByTitle("Preview")[1]);
    const dlg = await screen.findByRole("dialog");
    expect(title()).toHaveTextContent("x1.jpg");
    expect(title()).toHaveTextContent("X-ray");
    expect(title()).toHaveTextContent("2 of 3");
    expect(within(dlg).getByRole("link", { name: /Open original/ })).toHaveAttribute("href", "https://cdn/x1.jpg");
  });

  test("REG-FE-IMAGES-018 next and previous wrap around, and so do the arrow keys", async () => {
    const { user } = gallery();
    await user.click(screen.getAllByTitle("Preview")[2]);
    await screen.findByRole("dialog");
    expect(title()).toHaveTextContent("u1.jpg");
    // Uncategorised: no type pill.
    expect(title()).not.toHaveTextContent(/before|X-ray/);
    await user.click(screen.getByRole("button", { name: "Next image" }));
    expect(title()).toHaveTextContent("b1.jpg");
    expect(title()).toHaveTextContent("before");
    await user.click(screen.getByRole("button", { name: "Previous image" }));
    expect(title()).toHaveTextContent("u1.jpg");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowRight" });
    expect(title()).toHaveTextContent("b1.jpg");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowLeft" });
    expect(title()).toHaveTextContent("u1.jpg");
  });

  test("REG-FE-IMAGES-019 the filmstrip jumps straight to an image and marks the current one", async () => {
    const { user } = gallery();
    await user.click(screen.getAllByTitle("Preview")[0]);
    const dlg = await screen.findByRole("dialog");
    const strip = within(dlg).getByTitle("x1.jpg");
    await user.click(strip);
    expect(title()).toHaveTextContent("x1.jpg");
    expect(strip).toHaveAttribute("data-active", "1");
    expect(within(dlg).getByTitle("b1.jpg")).not.toHaveAttribute("data-active");
  });

  test("REG-FE-IMAGES-020 a tap on the image toggles between fit and fill, and moving on fits again", async () => {
    const { user } = gallery();
    await user.click(screen.getAllByTitle("Preview")[0]);
    const dlg = await screen.findByRole("dialog");
    const big = () => within(dlg).getAllByAltText("b1.jpg").find((i) => i.className.includes("cursor-zoom"))!;
    expect(big()).toHaveClass("object-contain");
    await user.click(big());
    expect(big()).toHaveClass("object-cover");
    await user.click(big());
    expect(big()).toHaveClass("object-contain");
    await user.click(big());
    await user.click(screen.getByRole("button", { name: "Next image" }));
    await user.click(screen.getByRole("button", { name: "Previous image" }));
    expect(big()).toHaveClass("object-contain");
  });

  test("REG-FE-IMAGES-021 a single image has no arrows, no counter and no filmstrip", async () => {
    const { user } = gallery([IM("only", "after")]);
    await user.click(screen.getByTitle("Preview"));
    await screen.findByRole("dialog");
    expect(screen.queryByRole("button", { name: "Next image" })).not.toBeInTheDocument();
    expect(title()).not.toHaveTextContent(/of 1/);
    expect(screen.queryByTitle("only.jpg")).not.toBeInTheDocument();
  });

  test("REG-FE-IMAGES-022 Delete in the viewer confirms, deletes that image and closes the viewer", async () => {
    const { user, onDelete } = gallery();
    await user.click(screen.getAllByTitle("Preview")[1]);
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /Delete/ }));
    const confirm = await screen.findByText("Delete this image?");
    const dlg = confirm.closest("[role=dialog]") as HTMLElement;
    await user.click(within(dlg).getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledWith("x1");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  test("REG-FE-IMAGES-023 read-only viewer: no delete anywhere", async () => {
    const { user } = gallery(three, false);
    expect(screen.queryByRole("button", { name: "Remove image" })).not.toBeInTheDocument();
    await user.click(screen.getAllByTitle("Preview")[0]);
    const dlg = await screen.findByRole("dialog");
    expect(within(dlg).queryByRole("button", { name: /Delete/ })).not.toBeInTheDocument();
  });

  test("REG-FE-IMAGES-024 closing the viewer with Esc", async () => {
    const { user } = gallery();
    await user.click(screen.getAllByTitle("Preview")[0]);
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});
