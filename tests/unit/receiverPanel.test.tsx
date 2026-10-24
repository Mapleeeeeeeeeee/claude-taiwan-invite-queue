// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeDto, MyQueueEntryDto } from "../../src/shared/types";
import {
  ReceiverPanel,
  type ReceiverPanelProps,
} from "../../src/client/components/ReceiverPanel";

// jsdom 沒有實作 scrollIntoView，錯誤提示出現時元件會呼叫它。
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  delete (Element.prototype as Partial<Element>).scrollIntoView;
});

function createLoggedInMe(overrides?: Partial<MeDto>): MeDto {
  return {
    user: {
      id: 10,
      email: "alice@claude-tw.dev",
      nickname: "Alice",
      invalidRetryCount: 0,
      invalidLinkStrikeCount: 0,
      isProviderBlocked: false,
      hasPushSubscription: false,
      isEligibleForNewbieTrack: true,
      hasSharedLinks: false,
    },
    myQueue: null,
    myConfirmedClaim: null,
    mySharedLinks: [],
    vapidPublicKey: "test-vapid-public-key",
    devLoginEnabled: false,
    googleClientId: "test-google-client-id",
    ...overrides,
  };
}

function createPanelProps(
  overrides?: Partial<ReceiverPanelProps>,
): ReceiverPanelProps {
  return {
    me: null,
    isSubmitting: false,
    actionError: null,
    isLoginRequired: false,
    nicknameInput: "阿明",
    thankYouMessageInput: "合法的感謝小卡內容！",
    isEligibleForNewbieTrack: true,
    isReportInvalidConfirmOpen: false,
    onNicknameChange: vi.fn(),
    onThankYouMessageChange: vi.fn(),
    onJoinQueue: vi.fn(async () => true),
    onRevealSlot: vi.fn(async () => true),
    onConfirmSlot: vi.fn(async () => true),
    onOpenReportInvalidConfirm: vi.fn(),
    onCloseReportInvalidConfirm: vi.fn(),
    onReportSlotInvalid: vi.fn(async () => true),
    onCancelQueue: vi.fn(async () => true),
    onCountdownExpire: vi.fn(),
    onRequireLogin: vi.fn(),
    push: {
      permissionState: "default",
      hasPendingGuestSubscription: false,
      enablePush: vi.fn(async () => true),
    },
    onTestPush: vi.fn(async () => true),
    ...overrides,
  };
}

describe("ReceiverPanel UX & Validation", () => {
  it("感謝小卡超過 200 字時不截斷輸入，但即時顯示超過字數並停用送出按鈕", () => {
    const handleJoinQueue = vi.fn(async () => true);
    const handleRequireLogin = vi.fn();
    const baseProps = createPanelProps({
      onJoinQueue: handleJoinQueue,
      onRequireLogin: handleRequireLogin,
    });

    const { rerender } = render(<ReceiverPanel {...baseProps} />);

    // 合法字數下，按鈕可用
    const submitBtn = screen.getByRole("button", {
      name: "使用 Google 帳號登入",
    });
    expect(submitBtn.hasAttribute("disabled")).toBe(false);

    // 重新渲染為超過 200 字的訊息
    rerender(
      <ReceiverPanel {...baseProps} thankYouMessageInput={"a".repeat(215)} />,
    );

    // 驗證輸入框沒有 maxLength 限制
    const textarea = screen.getByLabelText(/給提供者的感謝小卡/);
    expect(textarea.getAttribute("maxlength")).toBeNull();

    // 驗證顯示已超過 15 字提示
    expect(screen.getByText(/已超過 15 字/)).not.toBeNull();
    expect(screen.getByText(/感謝小卡不可超過 200 字/)).not.toBeNull();

    // 驗證按鈕變為停用狀態，且點擊不觸發登入或排隊
    const disabledBtn = screen.getByRole("button", {
      name: /字數超過 200 字上限/,
    });
    expect(disabledBtn.hasAttribute("disabled")).toBe(true);

    fireEvent.submit(textarea.closest("form")!);
    expect(handleJoinQueue).not.toHaveBeenCalled();
    expect(handleRequireLogin).not.toHaveBeenCalled();
  });

  it("伺服器回報需要登入時，顯示友善的 Google 登入引導卡片而非死板紅條", () => {
    const handleRequireLogin = vi.fn();

    render(
      <ReceiverPanel
        {...createPanelProps({
          actionError: "請先使用 Google 帳號登入",
          isLoginRequired: true,
          onRequireLogin: handleRequireLogin,
        })}
      />,
    );

    // 應渲染登入引導卡片而非一般 alert-error
    expect(screen.getByLabelText("登入引導提示")).not.toBeNull();
    expect(screen.getByText("請先使用 Google 帳號登入")).not.toBeNull();

    // 點擊引導卡片中的立即登入按鈕應呼叫 onRequireLogin
    const loginActionBtn = screen.getByRole("button", {
      name: /立即使用 Google 帳號登入/,
    });
    fireEvent.click(loginActionBtn);
    expect(handleRequireLogin).toHaveBeenCalledTimes(1);
  });

  // Regression: 登入引導靠比對錯誤訊息文字判斷，錯誤文案一改就失效 (review-convention Should Fix 8)
  it("錯誤訊息即使提到 Google 帳號登入，只要不是未登入錯誤，就維持一般紅條", () => {
    render(
      <ReceiverPanel
        {...createPanelProps({
          actionError: "此 Google 帳號登入已過期，請重新整理",
          isLoginRequired: false,
        })}
      />,
    );

    expect(screen.queryByLabelText("登入引導提示")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain(
      "此 Google 帳號登入已過期",
    );
  });

  it("已登入但不具新手軌資格時，提示已自動切換為再領取排隊，送出鈕改為再領取", () => {
    const baseProps = createPanelProps({ me: createLoggedInMe() });
    const { rerender } = render(
      <ReceiverPanel {...baseProps} isEligibleForNewbieTrack />,
    );

    expect(screen.queryByText(/已自動切換為再領取排隊/)).toBeNull();
    expect(
      screen.getByRole("button", { name: "加入排隊領取邀請連結" }),
    ).not.toBeNull();

    rerender(<ReceiverPanel {...baseProps} isEligibleForNewbieTrack={false} />);

    expect(screen.getByText(/已自動切換為再領取排隊/)).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "加入「再領取」排隊" }),
    ).not.toBeNull();
  });

  it("伺服器回傳歷史領取紀錄時，在表單上方顯示可展開的領取紀錄卡片", () => {
    const confirmedClaim: MyQueueEntryDto = {
      id: 77,
      status: "confirmed",
      track: "newbie",
      queuePosition: null,
      thankYouMessage: "謝謝小張版友熱情分享！祝順心！",
      slotId: 55,
      providerNickname: "小張",
      referralUrl: "https://claude.ai/referral/rNFlbuU0OA",
      reserveExpiresAt: null,
      confirmExpiresAt: null,
      canReportInvalid: false,
      isRequeuedWithPriority: false,
    };

    const { rerender } = render(
      <ReceiverPanel
        {...createPanelProps({
          me: createLoggedInMe({ myConfirmedClaim: confirmedClaim }),
        })}
      />,
    );
    expect(screen.getByTestId("claim-history-card").textContent).toContain(
      "小張",
    );

    rerender(
      <ReceiverPanel
        {...createPanelProps({
          me: createLoggedInMe({ myConfirmedClaim: null }),
        })}
      />,
    );
    expect(screen.queryByTestId("claim-history-card")).toBeNull();
  });

  it.each([
    { scenario: '伺服器回報排在第 4 順位', queuePosition: 4, expectedHeading: '排隊成功！你目前在第 4 順位' },
    { scenario: '伺服器沒有回報順位', queuePosition: null, expectedHeading: '排隊成功！' },
  ])('排隊等待中且$scenario時，標題顯示「$expectedHeading」，不捏造順位', ({ queuePosition, expectedHeading }) => {
    const waitingEntry: MyQueueEntryDto = {
      id: 5,
      status: "waiting",
      track: "newbie",
      queuePosition,
      thankYouMessage: "謝謝版友分享！",
      slotId: null,
      providerNickname: null,
      referralUrl: null,
      reserveExpiresAt: null,
      confirmExpiresAt: null,
      canReportInvalid: false,
      isRequeuedWithPriority: false,
    };

    render(
      <ReceiverPanel
        {...createPanelProps({ me: createLoggedInMe({ myQueue: waitingEntry }) })}
      />,
    );

    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(expectedHeading);
  });

  describe("優先重排提示", () => {
    function renderWaitingPanel(isRequeuedWithPriority: boolean) {
      const waitingEntry: MyQueueEntryDto = {
        id: 6,
        status: "waiting",
        track: "community",
        queuePosition: 1,
        thankYouMessage: "謝謝版友分享！",
        slotId: null,
        providerNickname: null,
        referralUrl: null,
        reserveExpiresAt: null,
        confirmExpiresAt: null,
        canReportInvalid: false,
        isRequeuedWithPriority,
      };
      const me = createLoggedInMe({ myQueue: waitingEntry });
      // 使用者終身已用掉 1 次重排機會，但這筆排隊紀錄是否被提升優先權由 isRequeuedWithPriority 決定。
      me.user!.invalidRetryCount = 1;
      render(<ReceiverPanel {...createPanelProps({ me })} />);
    }

    // Regression: 重排過一次的使用者再排新隊列，終身 invalidRetryCount 讓新紀錄誤顯示「已為你優先排回隊伍最前面」 (rereview-correctness Nit, rereview-convention Correctness 提示)
    it("終身重排次數為 1，但目前這筆排隊紀錄沒有被提升優先權時，不顯示優先排回提示", () => {
      renderWaitingPanel(false);

      expect(screen.queryByText(/已為你優先排回隊伍最前面/)).toBeNull();
    });

    it("目前這筆排隊紀錄被提升過優先權時，顯示優先排回提示與剩餘重排機會 0 次", () => {
      renderWaitingPanel(true);

      expect(screen.getByText(/已為你優先排回隊伍最前面，剩餘重排機會 0 次/)).not.toBeNull();
    });
  });
});
