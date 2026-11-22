/**
 * 主入口文件
 * 初始化、主流程控制、Switch Case逻辑、游戏结束处理
 *
 * 说明：本项目使用普通脚本(classic script)加载。StateManager 由 state.js 全局提供，
 * generateBankerOfferWithDrama 由 banker.js 全局提供，UI 由 ui.js 全局提供，
 * 因此此处不再使用 import。各脚本在 index.html 中按依赖顺序引入即可。
 */

// ========================================
// 游戏控制器
// ========================================
const GameController = {
    // 选箱飞行动画进行中的锁，防止动画期间误操作
    selectingAnimating: false,

    // 对局代次：每次 init / 重开都递增。所有挂起的异步流程（setTimeout、await 续体）
    // 都在创建时捕获代次，触发/续跑时先比对 this.generation，不一致即证明玩家已重开，
    // 旧流程一律作废，绝不允许把旧对局的报价/结算作用到新对局上。
    generation: 0,

    // 决策锁：防止同一笔决策被重复/重入触发（双击、Esc 过渡窗、还价结算延时窗）。
    // 仅在“玩家真正可以做决策”的时刻释放：报价弹窗完全展示、或交换弹窗完全展示、
    // 或下一轮开箱正式开始；弹窗过渡窗内始终保持锁定。
    decisionLock: false,

    // 受 generation 管理的定时器注册表。重开时统一 clear，旧回调连触发的机会都没有，
    // 与回调内部的代次比对构成双保险（也防止回调永远不触发造成句柄泄漏）。
    _timers: new Set(),

    /**
     * 注册受对局代次保护的定时器
     * @param {Function} callback
     * @param {number} delay
     * @returns {number} 定时器 id
     */
    _setTimeout(callback, delay) {
        const gen = this.generation;
        const id = setTimeout(() => {
            this._timers.delete(id);
            // 重开后旧回调一律作废
            if (gen !== this.generation) return;
            callback();
        }, delay);
        this._timers.add(id);
        return id;
    },

    /** 清空当前对局挂起的全部受管定时器（重开时调用） */
    _clearTimers() {
        this._timers.forEach((id) => clearTimeout(id));
        this._timers.clear();
    },

    /**
     * 受对局代次保护的延时 Promise。
     * 重开后 Promise 永远 pending（续体不再执行），从而保证 await 之后的
     * DOM/状态操作不会落到新对局上。
     * @param {number} delay
     * @returns {Promise<void>}
     */
    _delay(delay) {
        return new Promise((resolve) => {
            this._setTimeout(resolve, delay);
        });
    },

    /**
     * 初始化游戏
     */
    async init() {
        // 对局代次：用于让挂起的异步流程在重置时失效（bug #6）
        this.generation = (this.generation || 0) + 1;
        // 防御：init 理论上只执行一次，但仍清理可能残留的受管定时器
        this._clearTimers();
        // 决策锁：防止同一笔决策被重复/重入触发（修复 Bug A / Bug B）
        this.decisionLock = false;

        // 初始化主题（需先于 bindEvents，避免主题切换依赖的元素未就绪）
        this.initTheme();

        // 绑定事件（内部会确保元素已缓存）
        UI.bindEvents({
            onCaseClick: this.handleCaseClick.bind(this),
            onDeal: this.handleDeal.bind(this),
            onNoDeal: this.handleNoDeal.bind(this),
            onKeep: this.handleKeep.bind(this),
            onSwitch: this.handleSwitch.bind(this),
            onRestart: this.handleRestart.bind(this),
            onThemeToggle: this.handleThemeToggle.bind(this),
            onThemeSelect: this.handleThemeSelect.bind(this),
            onThemeClose: this.handleThemeClose.bind(this),
            onLangToggle: this.handleLangToggle.bind(this),
            onLangSelect: this.handleLangSelect.bind(this),
            onLangClose: this.handleLangClose.bind(this),
            onHaggle: this.handleHaggle.bind(this),
            onHaggleSubmit: this.handleHaggleSubmit.bind(this),
            onHaggleCancel: this.handleHaggleCancel.bind(this)
        });

        // 初始化语言（需先于首次渲染，默认跟随系统语言）
        this.initLanguage();

        // 重置游戏状态
        StateManager.reset();
        StateManager.initializeCases();

        // 重置 UI
        UI.resetUI();

        console.log('🎮 Deal or No Deal - 游戏初始化完成');
        console.log('📦 箱子分配:', Array.from(StateManager.getState().caseAssignments.entries()));
    },

    /**
     * 初始化主题（从 localStorage 或系统偏好）
     */
    initTheme() {
        // 已保存偏好可为 'light' | 'dark' | 'system'（无则视为跟随系统）
        const saved = localStorage.getItem('don_theme_preference');
        this.applyTheme(saved);

        // 仅当选择“跟随系统”时才随系统变化切换
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
            const pref = localStorage.getItem('don_theme_preference');
            if (pref === 'system' || pref === null) {
                this.applyTheme('system');
            }
        });
    },

    /**
     * 应用主题偏好（'light' | 'dark' | 'system' | null）
     */
    applyTheme(pref) {
        const effective = this.resolveTheme(pref);
        document.documentElement.setAttribute('data-theme', effective);
        UI.updateThemeIcon(effective);
        this.updateThemeUI(pref, effective);
    },

    /**
     * 解析实际生效主题：system 跟随系统，其它直接用偏好
     */
    resolveTheme(pref) {
        if (pref === 'light' || pref === 'dark') return pref;
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    },

    /**
     * 更新切换按钮图标与菜单选中态
     */
    updateThemeUI(pref, effective) {
        const normalized = (pref === null) ? 'system' : pref;
        const iconEl = document.getElementById('theme-current-icon');
        if (iconEl) {
            iconEl.textContent = (normalized === 'system') ? '🖥️' : (effective === 'dark' ? '🌙' : '☀️');
        }
        const menu = document.getElementById('theme-menu');
        if (menu) {
            menu.querySelectorAll('[data-theme-value]').forEach((li) => {
                li.classList.toggle('is-active', li.getAttribute('data-theme-value') === normalized);
            });
        }
    },

    /**
     * 展开/收起主题菜单（点击按钮触发）
     */
    handleThemeToggle() {
        const menu = document.getElementById('theme-menu');
        const btn = document.getElementById('theme-toggle');
        if (!menu || !btn) return;
        const willOpen = menu.hasAttribute('hidden');
        if (willOpen) {
            menu.removeAttribute('hidden');
            btn.setAttribute('aria-expanded', 'true');
        } else {
            menu.setAttribute('hidden', '');
            btn.setAttribute('aria-expanded', 'false');
        }
    },

    /**
     * 关闭主题菜单
     */
    handleThemeClose() {
        const menu = document.getElementById('theme-menu');
        const btn = document.getElementById('theme-toggle');
        if (menu && !menu.hasAttribute('hidden')) {
            menu.setAttribute('hidden', '');
            if (btn) btn.setAttribute('aria-expanded', 'false');
        }
    },

    /**
     * 选择具体主题（light / dark / system）并保存偏好
     */
    handleThemeSelect(value) {
        localStorage.setItem('don_theme_preference', value);
        this.applyTheme(value);
        this.handleThemeClose();
    },

    // ========================================
    // 语言切换（中文 / English / 跟随系统），默认跟随系统语言
    // ========================================

    /**
     * 初始化语言：读取偏好（默认跟随系统）并应用
     */
    initLanguage() {
        const saved = localStorage.getItem(LANG_STORAGE_KEY);
        this.applyLanguage(saved);
    },

    /**
     * 应用语言偏好（'zh' | 'en' | 'system' | null）
     */
    applyLanguage(pref) {
        const effective = resolveLanguage(pref);
        document.documentElement.setAttribute('lang', effective);
        // 静态文案（data-i18n 标注处）统一替换
        applyStaticI18n();
        // 动态文案（轮次信息 / 结算弹窗等）刷新
        if (typeof UI !== 'undefined' && UI.applyI18n) UI.applyI18n();
        this.updateLanguageUI(pref, effective);
    },

    /**
     * 更新语言按钮图标与菜单选中态
     */
    updateLanguageUI(pref, effective) {
        const normalized = (pref === null) ? 'system' : pref;
        const iconEl = document.getElementById('lang-current-icon');
        if (iconEl) {
            iconEl.textContent = normalized === 'system' ? '🌐' : (effective === 'en' ? 'EN' : '中');
        }
        const menu = document.getElementById('lang-menu');
        if (menu) {
            menu.querySelectorAll('[data-lang-value]').forEach((li) => {
                li.classList.toggle('is-active', li.getAttribute('data-lang-value') === normalized);
            });
        }
    },

    /**
     * 展开/收起语言菜单（点击按钮触发）
     */
    handleLangToggle() {
        const menu = document.getElementById('lang-menu');
        const btn = document.getElementById('lang-toggle');
        if (!menu || !btn) return;
        const willOpen = menu.hasAttribute('hidden');
        if (willOpen) {
            menu.removeAttribute('hidden');
            btn.setAttribute('aria-expanded', 'true');
        } else {
            menu.setAttribute('hidden', '');
            btn.setAttribute('aria-expanded', 'false');
        }
    },

    /**
     * 关闭语言菜单
     */
    handleLangClose() {
        const menu = document.getElementById('lang-menu');
        const btn = document.getElementById('lang-toggle');
        if (menu && !menu.hasAttribute('hidden')) {
            menu.setAttribute('hidden', '');
            if (btn) btn.setAttribute('aria-expanded', 'false');
        }
    },

    /**
     * 选择具体语言（zh / en / system）并保存偏好
     */
    handleLangSelect(value) {
        localStorage.setItem(LANG_STORAGE_KEY, value);
        this.applyLanguage(value);
        this.handleLangClose();
    },

    /**
     * 处理箱子点击
     * @param {number} caseNumber
     */
    async handleCaseClick(caseNumber) {
        const state = StateManager.getState();

        // 选箱飞行动画进行中，忽略其他点击，避免中途误操作
        if (this.selectingAnimating) return;

        // 阶段 1：选择玩家自己的箱子
        if (state.phase === GAME_PHASE.SELECTING_PLAYER_CASE) {
            const success = StateManager.selectPlayerCase(caseNumber);
            if (success) {
                UI.playSound('open');
                // 修复：selectPlayerCase 后需要重新获取状态以得到 playerCaseValue
                const newState = StateManager.getState();
                const gen = this.generation;
                this.selectingAnimating = true;
                await UI.animatePlayerCaseSelection(caseNumber, newState.playerCaseValue);
                this.selectingAnimating = false;
                // 飞行动画期间若玩家重开，后续渲染属于旧对局，一律作废
                if (gen !== this.generation) return;
                UI.renderMoneyPanels(); // 更新金额面板（玩家箱子金额标记）
            }
            return;
        }

        // 阶段 2：开箱阶段
        if (state.phase === GAME_PHASE.OPENING_CASES) {
            // 不能点击玩家自己的箱子，也不能点击已开启的箱子
            if (caseNumber === state.playerCaseNumber) return;
            if (state.openedCases.has(caseNumber)) return;
            if (state.openedThisRound >= state.boxesToOpenThisRound) return;

            // 执行开箱
            const result = StateManager.openCase(caseNumber);
            if (!result) return;

            // 播放开箱音效
            UI.playSound('open');

            // 捕获对局代次：翻转动画（800ms）期间可能发生重开
            const gen = this.generation;

            // 触发翻转动画
            await UI.animateCaseOpen(caseNumber, result.value);
            // 重开后旧对局的后续 UI 更新全部作废，不得污染新棋盘
            if (gen !== this.generation) return;

            // 高亮金额面板对应金额
            UI.highlightMoneyValue(result.value);

            // 更新轮次进度
            UI.updateRoundInfo();

            // 检查轮次是否完成
            if (StateManager.isRoundComplete()) {
                // 短暂延迟后进入银行家报价（间隔见 config.js 的 TIMING）
                const gap = (typeof TIMING !== 'undefined' && TIMING.roundCompleteToBankerCall != null)
                    ? TIMING.roundCompleteToBankerCall : 250;
                // 受管定时器：回调内部比对 generation，重开时还会被 _clearTimers 直接清除，
                // 双重保证旧对局的报价不会弹到新对局上
                this._setTimeout(() => this.triggerBankerOffer(), gap);
            }
        }
    },

    /**
     * 触发银行家报价
     */
    async triggerBankerOffer() {
        const gen = this.generation;

        // 进入报价流程即持有决策锁：从“本轮最后一箱开完”到“报价弹窗完全可交互”
        // 之间的思考延时、铃声、弹窗入场动画窗口内，任何决策输入（点击 / Esc / D / N）
        // 都不得被受理。锁只在下方阶段正式切换为 BANKER_OFFER 后才释放。
        this.decisionLock = true;
        UI.setButtonDisabled('btn-deal', true);
        UI.setButtonDisabled('btn-no-deal', true);

        // 计算报价（带戏剧性延迟）
        const { offer, isBait } = await generateBankerOfferWithDrama();
        // 若在此期间玩家点了“再来一局”，本轮报价作废，避免作用到新对局
        if (gen !== this.generation) return;

        // 保存报价到状态
        StateManager.setBankerOffer(offer);

        // 显示报价弹窗（传递 isBait 标记用于正确显示银行家评语）。
        // 必须先完成弹窗展示、再切换阶段与释放决策锁：否则 await 期间（铃声/音频 resume）
        // 旧代码提前启用按钮，玩家可在弹窗尚未就绪时触发 DEAL/NO DEAL，
        // 随后续体又把阶段覆盖回 BANKER_OFFER，造成阶段与锁状态撕裂。
        await UI.showBankerOffer(offer, isBait);
        // 展示期间同样可能发生重开
        if (gen !== this.generation) return;

        // 更新阶段（getState 返回浅拷贝，必须用 StateManager.setPhase 才能真正改写）
        StateManager.setPhase(GAME_PHASE.BANKER_OFFER);

        // 弹窗已完全展示、阶段已切换：此刻才是“真正可决策”的时刻，启用按钮并解锁
        UI.setButtonDisabled('btn-deal', false);
        UI.setButtonDisabled('btn-no-deal', false);
        this.decisionLock = false;
    },

    /**
     * 决策锁：同一笔决策（DEAL / NO DEAL / 保留 / 交换）只允许进入一次，
     * 防止快速双击、Esc 在弹窗关闭窗口期重入、以及还价结算延时窗口内误触
     * 导致重复结算或轮次错乱（修复 Bug A / Bug B）。
     * @returns {boolean} 是否允许继续处理本次决策
     */
    _canDecide() {
        if (StateManager.getState().isGameOver) return false;
        if (this.decisionLock) return false;
        this.decisionLock = true;
        return true;
    },

    /**
     * 处理接受报价
     */
    async handleDeal(haggleAccepted = false) {
        if (!this._canDecide()) return;
        // 捕获对局代次：下面显示结算的延时回调在重开后必须作废（修复 BUG-1）
        const gen = this.generation;
        UI.playSound('deal');
        UI.setButtonDisabled('btn-deal', true);
        UI.setButtonDisabled('btn-no-deal', true);
        // 决策后一并禁用还价按钮，避免过渡窗内还价被受理（修复 BUG-A）
        UI.setButtonDisabled('btn-haggle', true);

        // 还价被银行家接受时，记作 'banker-accepted'，结算页显示“银行家接受了报价”
        if (haggleAccepted) {
            StateManager.acceptHaggle();
        } else {
            StateManager.acceptDeal();
        }
        UI.hideBankerOffer();

        // 接受报价后的后续：翻转打开自己的箱子，揭晓里面到底是多少钱
        const playerCase = StateManager.getPlayerCase();
        await UI.animatePlayerCaseOpen(playerCase.value);
        // 揭晓动画期间若重开，旧对局不再弹结算窗
        if (gen !== this.generation) return;

        // 短暂延迟后显示结果（受管定时器：重开时直接清除，且回调内再做代次比对，
        // 避免弹出“幽灵结算窗”）
        this._setTimeout(() => UI.showResult(), TIMING.resultRevealDelay);
    },

    /**
     * 处理拒绝报价
     */
    async handleNoDeal() {
        if (!this._canDecide()) return;
        UI.playSound('open');
        UI.setButtonDisabled('btn-deal', true);
        UI.setButtonDisabled('btn-no-deal', true);
        // 决策后一并禁用还价按钮（修复 BUG-A）
        UI.setButtonDisabled('btn-haggle', true);

        StateManager.rejectDeal();

        // 检查是否进入 Switch Case
        const newState = StateManager.getState();
        // 进入交换阶段时复用背景遮罩（keepBackdrop=true），避免遮罩先隐后显的闪烁（修复 4.4）
        UI.hideBankerOffer(newState.phase === GAME_PHASE.SWITCH_CASE);

        if (newState.phase === GAME_PHASE.SWITCH_CASE) {
            // 刷新轮次信息为“最终轮”，避免仍停留在上一轮开箱提示（修复 4.6）
            UI.updateRoundInfo();
            // 决策锁在交换弹窗真正出现前绝不释放：银行家弹窗的离场动画有 250ms 过渡窗，
            // 期间 hidden 仍为 false，若提前解锁，Esc 会绕过按钮 disabled 重入 handleNoDeal，
            // 导致 consecutiveRejects 重复累加、enterSwitchCase 被二次执行（修复 BUG-2）。
            // 定时器受对局代次管理，重开时直接作废（修复 BUG-1）。
            this._setTimeout(() => {
                UI.showSwitchCase();
                // 交换弹窗已完全展示，这才是“保留 / 交换”真正可决策的时刻：
                // 启用按钮并释放决策锁
                UI.setButtonDisabled('btn-keep', false);
                UI.setButtonDisabled('btn-switch', false);
                this.decisionLock = false;
            }, TIMING.switchEnterDelay);
        } else {
            // 进入下一轮开箱。决策锁与按钮在银行家弹窗离场动画结束前保持锁定，
            // 防止过渡窗内 Esc / 连点重入 handleNoDeal 或误入 handleDeal（旧代码在此立即
            // 解锁，是过渡窗绕过的根因）。时长与弹窗离场动画一致（TIMING.modalExitDuration）。
            this._setTimeout(() => {
                this.decisionLock = false;
                UI.setButtonDisabled('btn-deal', false);
                UI.setButtonDisabled('btn-no-deal', false);
                // 下一轮报价将由 updateHaggleUI 按 haggleUsed 重新显隐；此处复位 disabled（修复 BUG-A）
                UI.setButtonDisabled('btn-haggle', false);
                // 修复: 同步刷新还价 UI 可见/隐藏状态，避免上一轮已用还价导致按钮残留显示
                UI.updateHaggleUI();
                UI.updateRoundInfo();
                UI.renderCasesGrid(); // 更新箱子状态
                UI.renderMoneyPanels(); // 更新金额面板
            }, TIMING.modalExitDuration);
        }
    },

    /**
     * 处理点击"讨价还价"按钮：展开还价输入面板
     * 整局仅能使用一次，由 state.haggleUsed 控制
     */
    async handleHaggle() {
        const state = StateManager.getState();
        if (state.haggleUsed) return;
        // 仅当处于银行家报价阶段且未锁定决策时才允许展开还价（修复 BUG-A）
        if (state.phase !== GAME_PHASE.BANKER_OFFER || this.decisionLock) return;
        UI.showHagglePanel();
    },

    /**
     * 处理取消还价
     */
    async handleHaggleCancel() {
        UI.hideHagglePanel();
    },

    /**
     * 处理提交还价：银行家可能接受或拒绝，整局仅此一次
     */
    async handleHaggleSubmit() {
        const state = StateManager.getState();
        if (state.haggleUsed) return;
        // 阶段/决策锁/已结束守卫：禁止在报价已作废或已决策后受理还价（修复 BUG-A）
        if (state.phase !== GAME_PHASE.BANKER_OFFER || state.isGameOver || this.decisionLock) return;

        const counter = Number(UI.getHaggleInputValue());
        if (!isFinite(counter) || counter <= 0) {
            UI.showHaggleResult(t('banker.haggle.invalid'), false);
            return;
        }

        const originalOffer = state.currentOffer;
        const expectedValue = StateManager.calculateExpectedValue();
        const decision = resolveHaggle(counter, originalOffer, expectedValue);

        // 整局仅一次：无论接受或拒绝，机会都用掉了（必须用 setHaggleUsed 改写真实状态）
        StateManager.setHaggleUsed(true);
        UI.hideHagglePanel();
        UI.updateHaggleUI();
        // 同步持有决策锁：从结果展示到 900ms 后自动走完流程的窗口内，
        // 任何 Esc / 连点都不得再触发 DEAL / NO DEAL / 二次还价
        this.decisionLock = true;

        if (decision.accepted) {
            // 直接更新当前报价（并修正最近一条报价历史），避免重复 push 同轮记录（bug #9）。
            // 当前报价与报价历史在此同步为成交金额，结算页 finalWinnings 亦取自同一值，
            // 保证“还价接受 → 历史 → 结算”三处金额完全一致。
            StateManager.setCurrentOffer(decision.finalOffer);
            UI.setOfferDisplay(decision.finalOffer);
            UI.playSound('deal');
            UI.showHaggleResult(t('banker.haggle.accepted', { amount: formatCurrency(decision.finalOffer) }), true);
            // 还价被接受后强制结束游戏（自动成交，禁用两个按钮并走 DEAL 流程）
            UI.setButtonDisabled('btn-deal', true);
            UI.setButtonDisabled('btn-no-deal', true);
            // 还价被接受即成交，禁用还价按钮（修复 BUG-A）
            UI.setButtonDisabled('btn-haggle', true);
            // 决策锁在整个结算窗口内保持锁定，阻止 Esc/连点重入；受管定时器保证回调只触发一次。
            // 回调内先释放锁再委托 handleDeal（handleDeal 自身的 _canDecide 守卫需要锁处于释放态），
            // 按钮全程 disabled，因此释放锁不会放开任何人工输入入口。
            this._setTimeout(() => {
                this.decisionLock = false;
                this.handleDeal(true);
            }, TIMING.haggleSettleDelay);
        } else {
            UI.showHaggleResult(t('banker.haggle.rejected', { amount: formatCurrency(originalOffer) }), false);
            // 银行家拒绝还价后，原报价作废，自动强制继续游戏（禁用两按钮并走 NO DEAL 流程，无需玩家点击）
            UI.setButtonDisabled('btn-deal', true);
            UI.setButtonDisabled('btn-no-deal', true);
            // 决策锁在结算窗口内保持锁定；回调内先释放再委托 handleNoDeal（其 _canDecide 需要释放态）。
            this._setTimeout(() => {
                // 还价被拒 = 玩家并未接受报价、选择继续游戏，这本身是对当档银行家报价的
                // 一次真实拒绝，应正常计入 consecutiveRejects（由 handleNoDeal→rejectDeal 完成，
                // 整个流程只调用一次，计数恰好 +1）。
                // 注意：切勿再调用 decrementConsecutiveRejects()，否则真实拒绝会被抵消、
                // 诱饵报价触发条件（baitTriggerRejects=3）被推迟一轮（修复 BUG-B 回归）。
                // 受管定时器保证此回调唯一触发一次，handleNoDeal 不会被重入。
                this.decisionLock = false;
                this.handleNoDeal();
            }, TIMING.haggleSettleDelay);
        }
    },

    /**
     * 处理保留原箱子
     */
    async handleKeep() {
        if (!this._canDecide()) return;
        // 捕获对局代次：下面显示结算的延时回调在重开后必须作废（修复 BUG-1）
        const gen = this.generation;
        // 决策即锁定两个交换按钮，杜绝弹窗离场动画期间二次点击/Esc
        UI.setButtonDisabled('btn-keep', true);
        UI.setButtonDisabled('btn-switch', true);
        UI.playSound('deal');
        StateManager.keepCase();
        UI.hideSwitchCase();

        // 保留原箱子后，翻转打开自己的箱子
        await UI.animatePlayerCaseOpen(StateManager.getPlayerCase().value);
        if (gen !== this.generation) return;

        // 短暂延迟后显示结果（受管定时器：重开时清除，避免弹出“幽灵结算窗”）
        this._setTimeout(() => UI.showResult(), TIMING.resultRevealDelay);
    },

    /**
     * 处理交换箱子
     */
    async handleSwitch() {
        if (!this._canDecide()) return;
        // 捕获对局代次：下面所有延时续体在重开后必须作废（修复 BUG-1）
        const gen = this.generation;
        // 决策即锁定两个交换按钮，杜绝弹窗离场/交换动画期间二次点击/Esc
        UI.setButtonDisabled('btn-keep', true);
        UI.setButtonDisabled('btn-switch', true);
        UI.playSound('deal');
        // 交换是唯一的状态真相来源：playerCaseValue / otherCaseValue / finalWinnings
        // 在此一次性改写，后续弹窗编号、翻箱揭晓与结算页全部读取同一份 state
        StateManager.switchCase();
        UI.hideSwitchCase();

        // 显示交换动画（受管延时：重开后后续 DOM 操作整体作废）
        const playerCaseEl = document.querySelector('.switch-case--player .switch-case__box');
        const otherCaseEl = document.querySelector('.switch-case--other .switch-case__box');

        if (playerCaseEl && otherCaseEl) {
            playerCaseEl.classList.add('switch-case__box--swapping');
            otherCaseEl.classList.add('switch-case__box--swapping');

            await this._delay(TIMING.switchAnimationDuration);
            if (gen !== this.generation) return;

            playerCaseEl.classList.remove('switch-case__box--swapping');
            otherCaseEl.classList.remove('switch-case__box--swapping');
        }

        // 更新显示的箱子编号（交换后）：编号同样来自 state，与结算共用同一数据源
        const playerCase = StateManager.getPlayerCase();
        const otherCase = StateManager.getOtherCase();
        document.getElementById('switch-player-case-num').textContent = playerCase.number;
        document.getElementById('switch-other-case-num').textContent = otherCase.number;

        // 交换后，翻转打开现在属于自己的箱子（金额取自交换后的 state，即原另一个箱子的金额）
        await UI.animatePlayerCaseOpen(playerCase.value);
        if (gen !== this.generation) return;

        // 短暂延迟后显示结果（受管定时器：重开时清除，避免弹出“幽灵结算窗”）
        this._setTimeout(() => UI.showResult(), TIMING.resultRevealDelay);
    },

    /**
     * 处理重新开始
     */
    handleRestart() {
        // 递增对局代次，使任何挂起的异步流程（银行家报价、还价延迟、结算延迟等）作废
        this.generation = (this.generation || 0) + 1;
        // 同步清空受管定时器：旧回调不再有任何触发机会（与代次比对构成双保险）
        this._clearTimers();
        this.decisionLock = false;
        UI.hideResult();

        // 完全重置并重新开始。
        // resetUI 内部会递增 UI 代次，使 UI 层挂起的动画/弹窗定时器一并作废。
        this.selectingAnimating = false;
        StateManager.reset();
        StateManager.initializeCases();
        UI.resetUI();

        console.log('🔄 新游戏开始，generation =', this.generation);
    }
};

// ========================================
// 启动游戏
// ========================================
// 修复：ES 模块可能在 DOMContentLoaded 后执行，需检查 readyState
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        GameController.init();
    });
} else {
    // DOM 已就绪，直接初始化
    GameController.init();
}

// 导出供调试用
window.DealOrNoDeal = {
    StateManager,
    GameController,
    UI,

    // ---- 可控随机：让箱子分配 / 报价 / 还价结果可复现（验收用） ----
    rng: {
        // 注入确定性伪随机序列（同一 seed 下整局完全可复现）
        setSeeded(seed) { GameRng.setSeeded(seed); },
        // 临时用自定义函数接管随机源（须返回 [0,1)）
        setCustom(fn) { GameRng.setCustom(fn); },
        // 恢复原生 Math.random
        reset() { GameRng.reset(); }
    },

    // ---- 可控定时：压缩链路等待，便于在浏览器中快速验收异步交接 ----
    timing: {
        // 备份原始 TIMING，便于 restore
        _original: { ...TIMING },
        // 将链路上的等待统一压缩为 ms（默认 10ms），传 null/undefined 恢复默认
        fast(ms = 10) {
            TIMING.roundCompleteToBankerCall = ms;
            TIMING.bankerThinkMin = ms;
            TIMING.bankerThinkMax = ms;
            TIMING.bankerRingDuration = ms;
            TIMING.modalExitDuration = ms;
            TIMING.switchEnterDelay = ms;
            TIMING.haggleSettleDelay = ms;
            TIMING.resultRevealDelay = ms;
            TIMING.switchAnimationDuration = ms;
        },
        // 恢复 config.js 中的原始时长
        restore() {
            Object.assign(TIMING, this._original);
        },
        // 逐项覆盖
        set(values) {
            Object.assign(TIMING, values || {});
        }
    },

    // ---- 异步交接观测点 ----
    // 当前对局代次：重开一次 +1，可用于断言旧回调所属对局已失效
    getGeneration() { return GameController.generation; },
    // 当前 UI 代次：resetUI 一次 +1
    getUiEpoch() { return UI.getUiEpoch(); },
    // 仍挂起的受管定时器数量（控制器 + UI 层），稳态下应为 0
    getPendingTimerCount() {
        return GameController._timers.size + UI.getPendingUiTimerCount();
    }
};

console.log('🎯 Deal or No Deal 模块加载完成');
console.log('💡 调试对象可通过 window.DealOrNoDeal 访问');