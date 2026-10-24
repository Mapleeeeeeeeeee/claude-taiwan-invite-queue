// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardDto, JoinQueueResult, MeDto, MyQueueEntryDto } from '../../src/shared/types';
import { ApiClientError, type InviteApiClient } from '../../src/client/api/apiClient';
import { useInviteApp } from '../../src/client/hooks/useInviteApp';
import type { RequestPushSubscription } from '../../src/client/hooks/usePushSubscription';

function createStubBoard(overrides?: Partial<BoardDto>): BoardDto {
  return {
    availableSlotsCount: 1,
    waitingQueueCount: 2,
    totalConfirmedCount: 5,
    newbieSlotsCount: 1,
    communitySlotsCount: 0,
    newbieQueueCount: 2,
    communityQueueCount: 0,
    thankYouWall: [],
    ...overrides,
  };
}

function createStubMe(overrides?: Partial<MeDto>): MeDto {
  return {
    user: {
      id: 10,
      email: 'alice@claude-tw.dev',
      nickname: 'Alice',
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
    devLoginEnabled: false,
    googleClientId: 'test-google-client-id',
    vapidPublicKey: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U',
    ...overrides,
  };
}

const NO_SUBSCRIPTION: RequestPushSubscription = async () => ({ subscription: null });

function renderInviteApp(
  apiClient: InviteApiClient,
  requestPushSubscription: RequestPushSubscription = NO_SUBSCRIPTION
) {
  return renderHook(() => useInviteApp({ apiClient, requestPushSubscription }));
}

function createStubMeWithUser(userOverrides: Partial<NonNullable<MeDto['user']>>): MeDto {
  const baseMe = createStubMe();
  return { ...baseMe, user: { ...baseMe.user!, ...userOverrides } };
}

function createStubQueueEntry(overrides: Partial<MyQueueEntryDto>): MyQueueEntryDto {
  return {
    id: 101,
    status: 'waiting',
    track: 'newbie',
    queuePosition: 1,
    thankYouMessage: '感謝分享邀請連結！',
    slotId: null,
    providerNickname: null,
    referralUrl: null,
    reserveExpiresAt: null,
    confirmExpiresAt: null,
    canReportInvalid: false,
    isRequeuedWithPriority: false,
    ...overrides,
  };
}

function createMockApiClient(overrides?: Partial<InviteApiClient>): InviteApiClient {
  return {
    fetchBoard: vi.fn(async () => createStubBoard()),
    fetchMe: vi.fn(async () => createStubMe()),
    loginWithGoogle: vi.fn(async () => ({
      user: { id: 10, email: 'alice@claude-tw.dev', nickname: 'Alice' },
    })),
    loginWithDevAccount: vi.fn(async () => ({
      user: { id: 10, email: 'alice@claude-tw.dev', nickname: 'Alice' },
    })),
    logout: vi.fn(async () => ({ loggedOut: true })),
    submitInviteLink: vi.fn(async () => ({ linkId: 1, matchedCount: 1 })),
    joinQueue: vi.fn(async () => ({ queueEntryId: 101, status: 'reserved' as const })),
    revealSlot: vi.fn(async () => ({
      referralUrl: 'https://claude.ai/referral/rNFlbuU0OA',
      confirmExpiresAt: '2026-10-22T01:30:00.000Z',
    })),
    confirmSlot: vi.fn(async () => ({ confirmed: true })),
    reportSlotInvalid: vi.fn(async () => ({ requeuedStatus: 'waiting' as const })),
    cancelQueue: vi.fn(async () => ({ cancelled: true })),
    subscribePush: vi.fn(async () => ({ subscribed: true })),
    testPushNotification: vi.fn(async () => ({
      sent: true,
      deliveredCount: 1,
      message: '測試通知已成功送出！',
    })),
    ...overrides,
  };
}

describe('useInviteApp ViewModel Hook', () => {
  it('元件掛載時自動載入看板與個人狀態，並帶入預設暱稱', async () => {
    const apiClient = createMockApiClient();

    const { result } = renderInviteApp(apiClient);

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.board?.availableSlotsCount).toBe(1);
    expect(result.current.me?.user?.nickname).toBe('Alice');
    expect(result.current.nicknameInput).toBe('Alice');
  });

  it('完整領取者狀態流轉：加入排隊 → 解鎖看碼 → 確認啟用，並正確更新狀態、看板與感謝提示', async () => {
    let currentMe = createStubMe();
    let currentBoard = createStubBoard({ availableSlotsCount: 1, totalConfirmedCount: 5 });

    const joinQueueSpy = vi.fn(async ({ thankYouMessage }: { thankYouMessage: string; nickname?: string }) => {
      currentBoard = createStubBoard({ availableSlotsCount: 0, totalConfirmedCount: 5 });
      currentMe = createStubMe({
        myQueue: {
          id: 101,
          status: 'reserved',
          track: 'newbie',
          queuePosition: null,
          thankYouMessage,
          slotId: 55,
          providerNickname: '小張',
          referralUrl: null,
          reserveExpiresAt: '2026-10-22T07:00:00.000Z',
          confirmExpiresAt: null,
          canReportInvalid: false,
          isRequeuedWithPriority: false,
        },
      });
      return { queueEntryId: 101, status: 'reserved' as const };
    });

    const apiClient = createMockApiClient({
      fetchBoard: vi.fn(async () => currentBoard),
      fetchMe: vi.fn(async () => currentMe),
      joinQueue: joinQueueSpy,
      revealSlot: vi.fn(async () => {
        currentMe = createStubMe({
          myQueue: {
            id: 101,
            status: 'revealed',
            track: 'newbie',
            queuePosition: null,
            thankYouMessage: '謝謝小張版友熱情分享！祝順心！',
            slotId: 55,
            providerNickname: '小張',
            referralUrl: 'https://claude.ai/referral/rNFlbuU0OA',
            reserveExpiresAt: '2026-10-22T07:00:00.000Z',
            confirmExpiresAt: '2026-10-22T01:30:00.000Z',
            canReportInvalid: true,
            isRequeuedWithPriority: false,
          },
        });
        return {
          referralUrl: 'https://claude.ai/referral/rNFlbuU0OA',
          confirmExpiresAt: '2026-10-22T01:30:00.000Z',
        };
      }),
      confirmSlot: vi.fn(async () => {
        currentBoard = createStubBoard({
          availableSlotsCount: 0,
          totalConfirmedCount: 6,
          thankYouWall: [
            {
              slotId: 55,
              receiverNickname: 'Alice',
              providerNickname: '小張',
              thankYouMessage: '謝謝小張版友熱情分享！祝順心！',
              confirmedAt: '2026-10-22T01:05:00.000Z',
            },
          ],
        });
        currentMe = createStubMe({
          myQueue: {
            id: 101,
            status: 'confirmed',
            track: 'newbie',
            queuePosition: null,
            thankYouMessage: '謝謝小張版友熱情分享！祝順心！',
            slotId: 55,
            providerNickname: '小張',
            referralUrl: 'https://claude.ai/referral/rNFlbuU0OA',
            reserveExpiresAt: '2026-10-22T07:00:00.000Z',
            confirmExpiresAt: '2026-10-22T01:30:00.000Z',
            canReportInvalid: false,
            isRequeuedWithPriority: false,
          },
        });
        return { confirmed: true };
      }),
    });

    const { result } = renderInviteApp(apiClient);

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      result.current.setThankYouMessageInput('謝謝小張版友熱情分享！祝順心！');
    });

    await act(async () => {
      const ok = await result.current.joinQueue();
      expect(ok).toBe(true);
    });

    expect(joinQueueSpy).toHaveBeenCalledWith({
      thankYouMessage: '謝謝小張版友熱情分享！祝順心！',
      track: 'newbie',
      nickname: 'Alice',
    });
    expect(result.current.actionSuccessMessage).toBe(
      '已為你保留名額，請於 6 小時內解鎖查看邀請連結！'
    );
    expect(result.current.me?.myQueue?.status).toBe('reserved');
    expect(result.current.me?.myQueue?.referralUrl).toBeNull();

    await act(async () => {
      const ok = await result.current.revealSlot();
      expect(ok).toBe(true);
    });

    expect(result.current.actionSuccessMessage).toBe(
      '已解鎖邀請連結！請於 30 分鐘內前往使用並確認啟用'
    );
    expect(result.current.me?.myQueue?.status).toBe('revealed');
    expect(result.current.me?.myQueue?.referralUrl).toBe('https://claude.ai/referral/rNFlbuU0OA');

    await act(async () => {
      const ok = await result.current.confirmSlot();
      expect(ok).toBe(true);
    });

    expect(result.current.actionSuccessMessage).toBe('感謝小卡已送達提供者！');
    expect(result.current.me?.myQueue?.status).toBe('confirmed');
    expect(result.current.board?.totalConfirmedCount).toBe(6);
    expect(result.current.board?.thankYouWall).toHaveLength(1);
  });

  it('處理回報無效並將排隊狀態更新為 waiting 第一順位與扣抵重排次數', async () => {
    let currentMe = createStubMe({
      myQueue: {
        id: 101,
        status: 'revealed',
        track: 'newbie',
        queuePosition: null,
        thankYouMessage: '感謝分享邀請連結！',
        slotId: 55,
        providerNickname: '小陳',
        referralUrl: 'https://claude.ai/referral/badcode1',
        reserveExpiresAt: '2026-10-22T07:00:00.000Z',
        confirmExpiresAt: '2026-10-22T01:30:00.000Z',
        canReportInvalid: true,
        isRequeuedWithPriority: false,
      },
    });

    const apiClient = createMockApiClient({
      fetchMe: vi.fn(async () => currentMe),
      reportSlotInvalid: vi.fn(async () => {
        currentMe = createStubMe({
          user: {
            id: 10,
            email: 'alice@claude-tw.dev',
            nickname: 'Alice',
            invalidRetryCount: 1,
            invalidLinkStrikeCount: 0,
            isProviderBlocked: false,
            hasPushSubscription: false,
            isEligibleForNewbieTrack: true,
            hasSharedLinks: false,
          },
          myQueue: {
            id: 101,
            status: 'waiting',
            track: 'newbie',
            queuePosition: 1,
            thankYouMessage: '感謝分享邀請連結！',
            slotId: null,
            providerNickname: null,
            referralUrl: null,
            reserveExpiresAt: null,
            confirmExpiresAt: null,
            canReportInvalid: false,
            isRequeuedWithPriority: true,
          },
        });
        return { requeuedStatus: 'waiting' as const };
      }),
    });

    const { result } = renderInviteApp(apiClient);

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      result.current.openReportInvalidConfirm();
    });
    expect(result.current.isReportInvalidConfirmOpen).toBe(true);

    await act(async () => {
      const ok = await result.current.reportSlotInvalid();
      expect(ok).toBe(true);
    });

    expect(result.current.isReportInvalidConfirmOpen).toBe(false);
    expect(result.current.actionSuccessMessage).toBe(
      '已為你優先排回隊伍最前面（剩餘重排機會 0 次），將優先為你配對下一組'
    );
    expect(result.current.me?.myQueue?.status).toBe('waiting');
    expect(result.current.me?.myQueue?.queuePosition).toBe(1);
    expect(result.current.me?.user?.invalidRetryCount).toBe(1);
  });

  it('提供者提交邀請連結成功後重設輸入框與預設名額數量為 3', async () => {
    const submitInviteLinkSpy = vi.fn(async () => ({ linkId: 9, matchedCount: 2 }));
    const apiClient = createMockApiClient({
      submitInviteLink: submitInviteLinkSpy,
    });

    const { result } = renderInviteApp(apiClient);

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      result.current.setRawUrlInput('https://claude.ai/referral/shareTest01?s=ios');
      result.current.setSlotCountInput(2);
    });

    await act(async () => {
      const ok = await result.current.submitInviteLink();
      expect(ok).toBe(true);
    });

    expect(submitInviteLinkSpy).toHaveBeenCalledWith({
      rawUrlInput: 'https://claude.ai/referral/shareTest01?s=ios',
      slotCount: 2,
      track: 'newbie',
      nickname: 'Alice',
    });
    expect(result.current.rawUrlInput).toBe('');
    expect(result.current.slotCountInput).toBe(3);
    expect(result.current.actionSuccessMessage).toBe(
      '分享成功！已立即為 2 位排隊版友保留名額'
    );
  });

  it('加入排隊或提交連結失敗時保留使用者表單輸入並顯示錯誤提示', async () => {
    const apiClient = createMockApiClient({
      joinQueue: vi.fn(async () => {
        throw new ApiClientError('ALREADY_IN_QUEUE', '你已經在排隊佇列中', 409);
      }),
      submitInviteLink: vi.fn(async () => {
        throw new ApiClientError('DUPLICATE_REFERRAL_CODE', '這組邀請連結已經被分享過囉', 409);
      }),
    });

    const { result } = renderInviteApp(apiClient);

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      result.current.setThankYouMessageInput('這是一段我已經辛苦打好的感謝小卡文字！');
    });

    await act(async () => {
      const ok = await result.current.joinQueue();
      expect(ok).toBe(false);
    });

    expect(result.current.actionError).toBe('你已經在排隊佇列中');
    expect(result.current.thankYouMessageInput).toBe('這是一段我已經辛苦打好的感謝小卡文字！');

    act(() => {
      result.current.setRawUrlInput('https://claude.ai/referral/rNFlbuU0OA?s=ios');
      result.current.setSlotCountInput(2);
    });

    await act(async () => {
      const ok = await result.current.submitInviteLink();
      expect(ok).toBe(false);
    });

    expect(result.current.actionError).toBe('這組邀請連結已經被分享過囉');
    expect(result.current.rawUrlInput).toBe('https://claude.ai/referral/rNFlbuU0OA?s=ios');
    expect(result.current.slotCountInput).toBe(2);
  });


  it('登入與測試推播成功後，分別顯示歡迎訊息與伺服器回傳的測試通知結果', async () => {
    const apiClient = createMockApiClient({
      loginWithGoogle: vi.fn(async () => ({
        user: { id: 20, email: 'bob@example.com', nickname: 'Bob' },
      })),
    });
    const { result } = renderInviteApp(apiClient);
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      expect(await result.current.loginWithGoogle('mock-id-token', 'Bob')).toBe(true);
    });
    expect(apiClient.loginWithGoogle).toHaveBeenCalledWith({
      idToken: 'mock-id-token',
      nickname: 'Bob',
    });
    expect(result.current.nicknameInput).toBe('Bob');
    expect(result.current.actionSuccessMessage).toBe('歡迎回來，Bob！');

    await act(async () => {
      expect(await result.current.testPushNotification()).toBe(true);
    });
    expect(result.current.actionSuccessMessage).toBe('測試通知已成功送出！');
  });

  it('取消排隊成功後重新載入個人狀態，排隊紀錄變為已取消並顯示取消訊息', async () => {
    let currentMe = createStubMe({
      myQueue: createStubQueueEntry({ status: 'waiting', queuePosition: 3 }),
    });
    const apiClient = createMockApiClient({
      fetchMe: vi.fn(async () => currentMe),
      cancelQueue: vi.fn(async () => {
        currentMe = createStubMe({
          myQueue: createStubQueueEntry({ status: 'cancelled', queuePosition: null }),
        });
        return { cancelled: true };
      }),
    });
    const { result } = renderInviteApp(apiClient);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.me?.myQueue?.status).toBe('waiting');

    await act(async () => {
      expect(await result.current.cancelQueue()).toBe(true);
    });

    expect(result.current.me?.myQueue?.status).toBe('cancelled');
    expect(result.current.actionSuccessMessage).toBe('已取消排隊');
  });

  it.each([
    {
      scenario: '純新手',
      userOverrides: { isEligibleForNewbieTrack: true, hasSharedLinks: false },
      expectedTrack: 'newbie',
    },
    {
      scenario: '已有領取紀錄者',
      userOverrides: { isEligibleForNewbieTrack: false, hasSharedLinks: false },
      expectedTrack: 'community',
    },
    {
      scenario: '分享過邀請連結的提供者',
      userOverrides: { isEligibleForNewbieTrack: false, hasSharedLinks: true },
      expectedTrack: 'community',
    },
  ] as const)(
    '$scenario 加入排隊時，依伺服器回報的新手軌資格送出 $expectedTrack 軌道',
    async ({ userOverrides, expectedTrack }) => {
      const apiClient = createMockApiClient({
        fetchMe: vi.fn(async () => createStubMeWithUser(userOverrides)),
      });
      const { result } = renderInviteApp(apiClient);
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      act(() => {
        result.current.setThankYouMessageInput('謝謝版友分享，祝順心！');
      });
      await act(async () => {
        await result.current.joinQueue();
      });

      expect(result.current.isEligibleForNewbieTrack).toBe(expectedTrack === 'newbie');
      expect(apiClient.joinQueue).toHaveBeenCalledWith(
        expect.objectContaining({ track: expectedTrack })
      );
    }
  );

  // Regression: runAction 遇到 409 不重新讀取 me，新手軌資格過期後重送仍帶 newbie (rereview-correctness Should Fix)
  it('本機的新手軌資格已過期而加入排隊得到 409 時，重新讀取個人狀態，下一次加入改以 community 軌道送出', async () => {
    let isEligibleForNewbieTrack = true;
    const apiClient = createMockApiClient({
      fetchMe: vi.fn(async () =>
        createStubMeWithUser({ isEligibleForNewbieTrack })
      ),
      joinQueue: vi.fn(async ({ track }) => {
        if (track === 'newbie' && !isEligibleForNewbieTrack) {
          throw new ApiClientError('NEWBIE_TRACK_ONLY', '請選擇再領取軌道', 409);
        }
        return { queueEntryId: 101, status: 'waiting' as const };
      }),
    });
    const { result } = renderInviteApp(apiClient);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    isEligibleForNewbieTrack = false;
    act(() => {
      result.current.setThankYouMessageInput('謝謝版友分享，祝順心！');
    });

    await act(async () => {
      expect(await result.current.joinQueue()).toBe(false);
    });
    expect(result.current.isEligibleForNewbieTrack).toBe(false);
    await act(async () => {
      expect(await result.current.joinQueue()).toBe(true);
    });

    expect(apiClient.joinQueue).toHaveBeenLastCalledWith(
      expect.objectContaining({ track: 'community' })
    );
  });

  it('提供者選擇再領取受眾後提交連結，名額以 community 軌道送出，成功後受眾選項恢復預設', async () => {
    const apiClient = createMockApiClient();
    const { result } = renderInviteApp(apiClient);
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      result.current.setRawUrlInput('https://claude.ai/referral/shareTest02');
      result.current.setProviderTrackInput('community');
    });
    await act(async () => {
      await result.current.submitInviteLink();
    });

    expect(apiClient.submitInviteLink).toHaveBeenCalledWith(
      expect.objectContaining({ track: 'community' })
    );
    expect(result.current.providerTrackInput).toBe('newbie');
  });

  describe('需要登入的錯誤', () => {
    it('動作因未登入被拒絕時要求顯示登入引導，清除訊息後恢復', async () => {
      const apiClient = createMockApiClient({
        joinQueue: vi.fn(async () => {
          throw new ApiClientError('UNAUTHORIZED', '請先使用 Google 帳號登入', 401);
        }),
      });
      const { result } = renderInviteApp(apiClient);
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.joinQueue();
      });
      expect(result.current.isLoginRequired).toBe(true);

      act(() => {
        result.current.clearMessages();
      });
      expect(result.current.isLoginRequired).toBe(false);
    });

    // Regression: 登入引導靠比對錯誤訊息文字判斷，改成以錯誤碼 UNAUTHORIZED 判斷 (review-convention Should Fix 8)
    it('其他錯誤即使訊息提到 Google 帳號登入，也不要求顯示登入引導', async () => {
      const apiClient = createMockApiClient({
        joinQueue: vi.fn(async () => {
          throw new ApiClientError('ALREADY_IN_QUEUE', 'Google 帳號登入的使用者已在排隊中', 409);
        }),
      });
      const { result } = renderInviteApp(apiClient);
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.joinQueue();
      });

      expect(result.current.actionError).toBe('Google 帳號登入的使用者已在排隊中');
      expect(result.current.isLoginRequired).toBe(false);
    });
  });

  describe('提供者分享成功後的推播訂閱', () => {
    const browserSubscription = {
      endpoint: 'https://push.example.test/sub/abc',
      keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
    };

    function createStatefulApiClient() {
      let hasPushSubscription = false;
      return createMockApiClient({
        fetchMe: vi.fn(async () => createStubMeWithUser({ hasPushSubscription })),
        subscribePush: vi.fn(async () => {
          hasPushSubscription = true;
          return { subscribed: true };
        }),
      });
    }

    async function submitLink(result: { current: ReturnType<typeof useInviteApp> }) {
      act(() => {
        result.current.setRawUrlInput('https://claude.ai/referral/shareTest03');
      });
      await act(async () => {
        await result.current.submitInviteLink();
      });
    }

    it('尚未訂閱的使用者分享成功且瀏覽器給出訂閱時，完成訂閱並保留分享成功提示', async () => {
      const apiClient = createStatefulApiClient();
      const requestPushSubscription = vi.fn(async () => ({ subscription: browserSubscription }));
      const { result } = renderInviteApp(apiClient, requestPushSubscription);
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await submitLink(result);

      expect(apiClient.subscribePush).toHaveBeenCalledWith(browserSubscription);
      expect(result.current.me?.user?.hasPushSubscription).toBe(true);
      expect(result.current.actionSuccessMessage).toBe(
        '分享成功！已立即為 1 位排隊版友保留名額'
      );
    });

    it('瀏覽器沒有給出訂閱（拒絕或不支援）時，分享仍成功，也不送出任何訂閱', async () => {
      const apiClient = createStatefulApiClient();
      const { result } = renderInviteApp(apiClient, NO_SUBSCRIPTION);
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await submitLink(result);

      expect(apiClient.subscribePush).not.toHaveBeenCalled();
      expect(result.current.me?.user?.hasPushSubscription).toBe(false);
      expect(result.current.actionError).toBeNull();
      expect(result.current.actionSuccessMessage).toBe(
        '分享成功！已立即為 1 位排隊版友保留名額'
      );
    });

    it('已訂閱推播的使用者分享成功後，不再向瀏覽器要求推播權限', async () => {
      const apiClient = createMockApiClient({
        fetchMe: vi.fn(async () => createStubMeWithUser({ hasPushSubscription: true })),
      });
      const requestPushSubscription = vi.fn(async () => ({ subscription: browserSubscription }));
      const { result } = renderInviteApp(apiClient, requestPushSubscription);
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await submitLink(result);

      expect(requestPushSubscription).not.toHaveBeenCalled();
      expect(apiClient.subscribePush).not.toHaveBeenCalled();
    });

    it('分享失敗時不向瀏覽器要求推播權限', async () => {
      const apiClient = createMockApiClient({
        submitInviteLink: vi.fn(async () => {
          throw new ApiClientError('DUPLICATE_REFERRAL_CODE', '這組邀請連結已經被分享過囉', 409);
        }),
      });
      const requestPushSubscription = vi.fn(async () => ({ subscription: browserSubscription }));
      const { result } = renderInviteApp(apiClient, requestPushSubscription);
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await submitLink(result);

      expect(requestPushSubscription).not.toHaveBeenCalled();
      expect(result.current.actionError).toBe('這組邀請連結已經被分享過囉');
    });
  });

  it('重新載入後感謝牆多了新的卡片時，畫面資料更新為新內容', async () => {
    const wallItem = {
      slotId: 55,
      receiverNickname: 'Alice',
      providerNickname: '小張',
      thankYouMessage: '謝謝小張版友熱情分享！祝順心！',
      confirmedAt: '2026-10-22T01:05:00.000Z',
    };
    let currentWall = [wallItem];
    const apiClient = createMockApiClient({
      fetchBoard: vi.fn(async () => createStubBoard({ thankYouWall: currentWall })),
    });
    const { result } = renderInviteApp(apiClient);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.board?.thankYouWall).toHaveLength(1);

    currentWall = [wallItem, { ...wallItem, slotId: 56 }];
    await act(async () => {
      await result.current.refreshAll();
    });

    expect(result.current.board?.thankYouWall.map((item) => item.slotId)).toEqual([55, 56]);
  });
});

describe('useInviteApp 動作成功後的看板重抓', () => {
  it('頁面載入時的看板請求走瀏覽器快取', async () => {
    const apiClient = createMockApiClient();
    const { result } = renderInviteApp(apiClient);
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(apiClient.fetchBoard).toHaveBeenCalledTimes(1);
    expect(apiClient.fetchBoard).toHaveBeenLastCalledWith(undefined);
  });

  it.each([
    { action: '加入排隊', run: (vm: ReturnType<typeof useInviteApp>) => vm.joinQueue() },
    { action: '取消排隊', run: (vm: ReturnType<typeof useInviteApp>) => vm.cancelQueue() },
    { action: '分享邀請連結', run: (vm: ReturnType<typeof useInviteApp>) => vm.submitInviteLink() },
    { action: '回報無效', run: (vm: ReturnType<typeof useInviteApp>) => vm.reportSlotInvalid() },
    { action: '確認啟用', run: (vm: ReturnType<typeof useInviteApp>) => vm.confirmSlot() },
  ])('$action 成功後，重抓看板的請求繞過瀏覽器快取', async ({ run }) => {
    const apiClient = createMockApiClient();
    const { result } = renderInviteApp(apiClient);
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      expect(await run(result.current)).toBe(true);
    });

    expect(apiClient.fetchBoard).toHaveBeenLastCalledWith({ bypassBrowserCache: true });
  });
});

describe('useInviteApp 回到前景時的靜默刷新', () => {
  const START_TIME = new Date('2026-10-22T00:00:00.000Z');
  const RESUME_GAP_MS = 5_000;

  function setVisibility(state: DocumentVisibilityState) {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    document.dispatchEvent(new Event('visibilitychange'));
  }

  function leaveAndReturn() {
    act(() => setVisibility('hidden'));
    act(() => setVisibility('visible'));
  }

  function restoreFromBackForwardCache(isPersisted: boolean) {
    act(() => {
      window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: isPersisted }));
    });
  }

  function advanceClock(ms: number) {
    vi.setSystemTime(new Date(Date.now() + ms));
  }

  async function renderLoadedInviteApp(apiClient: InviteApiClient) {
    const rendered = renderInviteApp(apiClient);
    await waitFor(() => expect(rendered.result.current.isLoading).toBe(false));
    return rendered;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START_TIME);
  });

  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(document, 'visibilityState');
  });

  it('Given 排隊中的使用者 When 收到保留名額的推播後回到前景 Then 畫面換成最新狀態，且看板請求繞過瀏覽器快取', async () => {
    let currentMe = createStubMe({ myQueue: createStubQueueEntry({ status: 'waiting' }) });
    let currentBoard = createStubBoard({ waitingQueueCount: 1 });
    const apiClient = createMockApiClient({
      fetchMe: vi.fn(async () => currentMe),
      fetchBoard: vi.fn(async () => currentBoard),
    });
    const { result } = await renderLoadedInviteApp(apiClient);
    expect(result.current.me?.myQueue?.status).toBe('waiting');

    currentMe = createStubMe({
      myQueue: createStubQueueEntry({ status: 'reserved', queuePosition: null }),
    });
    currentBoard = createStubBoard({ waitingQueueCount: 0 });
    leaveAndReturn();

    await waitFor(() => expect(result.current.me?.myQueue?.status).toBe('reserved'));
    expect(result.current.board?.waitingQueueCount).toBe(0);
    expect(apiClient.fetchBoard).toHaveBeenCalledTimes(2);
    expect(apiClient.fetchBoard).toHaveBeenLastCalledWith({ bypassBrowserCache: true });
  });

  it('Given 頁面一直是可見的 When 收到 visibilitychange 但狀態是 hidden Then 不刷新', async () => {
    const apiClient = createMockApiClient();
    await renderLoadedInviteApp(apiClient);

    act(() => setVisibility('hidden'));

    expect(apiClient.fetchBoard).toHaveBeenCalledTimes(1);
    expect(apiClient.fetchMe).toHaveBeenCalledTimes(1);
  });

  it('Given 剛回到前景並刷新過 When 間隔不到最小間隔又來回切換多次 Then 不再重抓，間隔過後才會再刷新', async () => {
    const apiClient = createMockApiClient();
    await renderLoadedInviteApp(apiClient);

    leaveAndReturn();
    await waitFor(() => expect(apiClient.fetchBoard).toHaveBeenCalledTimes(2));

    advanceClock(RESUME_GAP_MS - 1);
    leaveAndReturn();
    leaveAndReturn();
    expect(apiClient.fetchBoard).toHaveBeenCalledTimes(2);
    expect(apiClient.fetchMe).toHaveBeenCalledTimes(2);

    advanceClock(1);
    leaveAndReturn();
    await waitFor(() => expect(apiClient.fetchBoard).toHaveBeenCalledTimes(3));
  });

  it('Given 頁面從 bfcache 還原 When pageshow 的 persisted 為 true Then 刷新一次；為 false 的一般載入不重複刷新', async () => {
    const apiClient = createMockApiClient();
    await renderLoadedInviteApp(apiClient);

    restoreFromBackForwardCache(false);
    expect(apiClient.fetchBoard).toHaveBeenCalledTimes(1);

    restoreFromBackForwardCache(true);
    await waitFor(() => expect(apiClient.fetchBoard).toHaveBeenCalledTimes(2));
  });

  it('Given 同一次還原同時觸發 visibilitychange 與 pageshow Then 只刷新一次', async () => {
    const apiClient = createMockApiClient();
    await renderLoadedInviteApp(apiClient);

    act(() => setVisibility('visible'));
    restoreFromBackForwardCache(true);

    await waitFor(() => expect(apiClient.fetchBoard).toHaveBeenCalledTimes(2));
    expect(apiClient.fetchMe).toHaveBeenCalledTimes(2);
  });

  it('Given 畫面已有內容 When 回到前景刷新進行中 Then 不顯示載入中，刷新失敗也不出現看板錯誤', async () => {
    const apiClient = createMockApiClient();
    const { result } = await renderLoadedInviteApp(apiClient);
    const boardBeforeResume = result.current.board;

    let rejectBoard: (reason: unknown) => void = () => {};
    vi.mocked(apiClient.fetchBoard).mockImplementationOnce(
      () => new Promise((_, reject) => (rejectBoard = reject))
    );
    leaveAndReturn();
    expect(result.current.isLoading).toBe(false);

    await act(async () => {
      rejectBoard(new ApiClientError('INTERNAL_ERROR', '網路連線異常', 0));
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.boardError).toBeNull();
    expect(result.current.board).toBe(boardBeforeResume);
  });

  it('Given 提交動作進行中 When 回到前景 Then 不刷新，動作完成後的重抓照常進行', async () => {
    let finishJoinQueue: () => void = () => {};
    const apiClient = createMockApiClient({
      joinQueue: vi.fn(
        () =>
          new Promise<JoinQueueResult>((resolve) => {
            finishJoinQueue = () => resolve({ queueEntryId: 101, status: 'waiting' as const });
          })
      ),
    });
    const { result } = await renderLoadedInviteApp(apiClient);

    let joinPromise: Promise<boolean> = Promise.resolve(false);
    act(() => {
      joinPromise = result.current.joinQueue();
    });
    await waitFor(() => expect(result.current.isSubmitting).toBe(true));
    leaveAndReturn();

    expect(apiClient.fetchBoard).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishJoinQueue();
      await joinPromise;
    });
    expect(apiClient.fetchBoard).toHaveBeenCalledTimes(2);
    expect(apiClient.fetchBoard).toHaveBeenLastCalledWith({ bypassBrowserCache: true });
  });

  it('Given 使用者正在輸入且開著回報無效對話框 When 回到前景刷新 Then 輸入內容與對話框維持原樣', async () => {
    const apiClient = createMockApiClient();
    const { result } = await renderLoadedInviteApp(apiClient);
    expect(result.current.nicknameInput).toBe('Alice');

    act(() => {
      result.current.setNicknameInput('小明');
      result.current.setThankYouMessageInput('謝謝大家');
      result.current.setRawUrlInput('https://claude.ai/referral/abc');
      result.current.openReportInvalidConfirm();
    });
    leaveAndReturn();
    await waitFor(() => expect(apiClient.fetchMe).toHaveBeenCalledTimes(2));

    expect(result.current.nicknameInput).toBe('小明');
    expect(result.current.thankYouMessageInput).toBe('謝謝大家');
    expect(result.current.rawUrlInput).toBe('https://claude.ai/referral/abc');
    expect(result.current.isReportInvalidConfirmOpen).toBe(true);
  });
});
