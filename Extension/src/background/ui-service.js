/**
 * This file is part of Adguard Browser Extension (https://github.com/AdguardTeam/AdguardBrowserExtension).
 *
 * Adguard Browser Extension is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * Adguard Browser Extension is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with Adguard Browser Extension. If not, see <http://www.gnu.org/licenses/>.
 */

/* eslint-disable max-len */

import { application } from './application';
import { backgroundPage } from './extension-api/background-page';
import { utils, unload, BACKGROUND_TAB_ID } from './utils/common';
import { listeners } from './notifier';
import { settings } from './settings/user-settings';
import { tabsApi } from './tabs/tabs-api';
import { prefs } from './prefs';
import { pageStats } from './filter/page-stats';
import { frames } from './tabs/frames';
import { notifications } from './utils/notifications';
import { allowlist } from './filter/allowlist';
import { userrules } from './filter/userrules';
import { browserUtils } from './utils/browser-utils';
import { log } from '../common/log';
import { runtimeImpl } from '../common/common-script';
import { MESSAGE_TYPES } from '../common/constants';
import { translator } from '../common/translators/translator';

/**
 * UI service
 */
export const uiService = (function () {
    const browserActionTitle = translator.getMessage('name');

    const contextMenuCallbackMappings = {
        'context_block_site_ads': function () {
            openAssistant();
        },
        'context_block_site_element': function () {
            openAssistant(true);
        },
        'context_security_report': async function () {
            const tab = await tabsApi.getActive();
            if (tab) {
                openSiteReportTab(tab.url);
            }
        },
        'context_complaint_website': async function () {
            const tab = await tabsApi.getActive();
            if (tab) {
                openAbuseTab(tab.url);
            }
        },
        'context_site_filtering_on': async function () {
            const tab = await tabsApi.getActive();
            if (tab) {
                unAllowlistTab(tab);
            }
        },
        'context_site_filtering_off': async function () {
            const tab = await tabsApi.getActive();
            if (tab) {
                allowlistTab(tab);
            }
        },
        'context_enable_protection': function () {
            changeApplicationFilteringDisabled(false);
        },
        'context_disable_protection': function () {
            changeApplicationFilteringDisabled(true);
        },
        'context_open_settings': function () {
            openSettingsTab();
        },
        'context_open_log': function () {
            openFilteringLog();
        },
        'context_update_antibanner_filters': function () {
            checkFiltersUpdates();
        },
    };

    const extensionStoreLink = (function () {
        let browser = 'chrome';
        if (browserUtils.isOperaBrowser()) {
            browser = 'opera';
        } else if (browserUtils.isFirefoxBrowser()) {
            browser = 'firefox';
        } else if (browserUtils.isEdgeChromiumBrowser()) {
            browser = 'edge';
        }

        const action = `${browser}_store`;

        return `https://adguard.com/forward.html?action=${action}&from=options_screen&app=browser_extension`;
    })();

    const THANKYOU_PAGE_URL = 'https://welcome.adguard.com/v2/thankyou.html';

    /**
     * Update icon for tab
     * @param tab Tab
     * @param options Options for icon or badge values
     */
    async function updateTabIcon(tab, options) {
        let icon;
        let badge;
        let badgeColor = '#555';

        if (tab.tabId === BACKGROUND_TAB_ID) {
            return;
        }

        try {
            if (options) {
                icon = options.icon;
                badge = options.badge;
            } else {
                let blocked;
                let disabled;

                const tabInfo = frames.getFrameInfo(tab);
                disabled = tabInfo.applicationFilteringDisabled;
                disabled = disabled || tabInfo.documentAllowlisted;

                if (!disabled && settings.showPageStatistic()) {
                    blocked = tabInfo.totalBlockedTab.toString();
                } else {
                    blocked = '0';
                }

                if (disabled) {
                    icon = prefs.ICONS.ICON_GRAY;
                } else {
                    icon = prefs.ICONS.ICON_GREEN;
                }

                badge = utils.workaround.getBlockedCountText(blocked);

                // If there's an active notification, indicate it on the badge
                const notification = notifications.getCurrentNotification();
                if (notification) {
                    badge = notification.badgeText || badge;
                    badgeColor = notification.badgeBgColor || badgeColor;

                    const hasSpecialIcons = !!notification.icons;

                    if (hasSpecialIcons) {
                        if (disabled) {
                            icon = notification.icons.ICON_GRAY;
                        } else {
                            icon = notification.icons.ICON_GREEN;
                        }
                    }
                }
            }

            await backgroundPage.browserAction.setBrowserAction(tab, icon, badge, badgeColor, browserActionTitle);
        } catch (ex) {
            log.error('Error while updating icon for tab {0}: {1}', tab.tabId, new Error(ex));
        }
    }

    const updateTabIconAsync = utils.concurrent.debounce((tab) => {
        updateTabIcon(tab);
    }, 250);

    /**
     * Update extension browser action popup window
     * @param tab - active tab
     */
    function updatePopupStats(tab) {
        const tabInfo = frames.getFrameInfo(tab);
        if (!tabInfo) {
            return;
        }

        runtimeImpl.sendMessage({
            type: 'updateTotalBlocked',
            tabInfo,
        }).catch(() => {
            // throws errors if popup is closed, ignore them
        });
    }

    const updatePopupStatsAsync = utils.concurrent.debounce((tab) => {
        updatePopupStats(tab);
    }, 250);

    /**
     * Creates context menu item
     * @param title Title id
     * @param options Create options
     */
    function addMenu(title, options) {
        const createProperties = {
            contexts: ['all'],
            title: translator.getMessage(title),
        };
        if (options) {
            if (options.id) {
                createProperties.id = options.id;
            }
            if (options.parentId) {
                createProperties.parentId = options.parentId;
            }
            if (options.disabled) {
                createProperties.enabled = false;
            }
            if (options.messageArgs) {
                createProperties.title = translator.getMessage(title, options.messageArgs);
            }
            if (options.contexts) {
                createProperties.contexts = options.contexts;
            }
            if ('checkable' in options) {
                createProperties.checkable = options.checkable;
            }
            if ('checked' in options) {
                createProperties.checked = options.checked;
            }
        }
        let callback;
        if (options && options.action) {
            callback = contextMenuCallbackMappings[options.action];
        } else {
            callback = contextMenuCallbackMappings[title];
        }
        if (typeof callback === 'function') {
            createProperties.onclick = callback;
        }
        backgroundPage.contextMenus.create(createProperties);
    }

    function customizeContextMenu(tab) {
        function addSeparator() {
            backgroundPage.contextMenus.create({
                type: 'separator',
            });
        }

        const tabInfo = frames.getFrameInfo(tab);

        if (tabInfo.applicationFilteringDisabled) {
            addMenu('context_site_protection_disabled');
            addSeparator();
            addMenu('context_open_log');
            addMenu('context_open_settings');
            addMenu('context_enable_protection');
        } else if (tabInfo.urlFilteringDisabled) {
            addMenu('context_site_filtering_disabled');
            addSeparator();
            addMenu('context_open_log');
            addMenu('context_open_settings');
            addMenu('context_update_antibanner_filters');
        } else {
            if (tabInfo.documentAllowlisted && !tabInfo.userAllowlisted) {
                addMenu('context_site_exception');
            } else if (tabInfo.canAddRemoveRule) {
                if (tabInfo.documentAllowlisted) {
                    addMenu('context_site_filtering_on');
                } else {
                    addMenu('context_site_filtering_off');
                }
            }
            addSeparator();

            if (!tabInfo.documentAllowlisted) {
                addMenu('context_block_site_ads');
                addMenu('context_block_site_element', { contexts: ['image', 'video', 'audio'] });
            }
            addMenu('context_security_report');
            addMenu('context_complaint_website');
            addSeparator();
            addMenu('context_update_antibanner_filters');
            addSeparator();
            addMenu('context_open_settings');
            addMenu('context_open_log');
            addMenu('context_disable_protection');
        }
    }

    function customizeMobileContextMenu(tab) {
        const tabInfo = frames.getFrameInfo(tab);

        if (tabInfo.applicationFilteringDisabled) {
            addMenu('popup_site_protection_disabled_android', {
                action: 'context_enable_protection',
                checked: true,
                checkable: true,
            });
            addMenu('popup_open_log_android', { action: 'context_open_log' });
            addMenu('popup_open_settings', { action: 'context_open_settings' });
        } else if (tabInfo.urlFilteringDisabled) {
            addMenu('context_site_filtering_disabled');
            addMenu('popup_open_log_android', { action: 'context_open_log' });
            addMenu('popup_open_settings', { action: 'context_open_settings' });
            addMenu('context_update_antibanner_filters');
        } else {
            addMenu('popup_site_protection_disabled_android', {
                action: 'context_disable_protection',
                checked: false,
                checkable: true,
            });
            if (tabInfo.documentAllowlisted && !tabInfo.userAllowlisted) {
                addMenu('popup_in_allowlist_android');
            } else if (tabInfo.canAddRemoveRule) {
                if (tabInfo.documentAllowlisted) {
                    addMenu('popup_site_filtering_state', {
                        action: 'context_site_filtering_on',
                        checkable: true,
                        checked: false,
                    });
                } else {
                    addMenu('popup_site_filtering_state', {
                        action: 'context_site_filtering_off',
                        checkable: true,
                        checked: true,
                    });
                }
            }

            if (!tabInfo.documentAllowlisted) {
                addMenu('popup_block_site_ads_android', { action: 'context_block_site_ads' });
            }
            addMenu('popup_open_log_android', { action: 'context_open_log' });
            addMenu('popup_security_report_android', { action: 'context_security_report' });
            addMenu('popup_open_settings', { action: 'context_open_settings' });
            addMenu('context_update_antibanner_filters');
        }
    }

    /**
     * Update context menu for tab
     * @param tab Tab
     */
    function updateTabContextMenu(tab) {
        // Isn't supported by Android WebExt
        if (!backgroundPage.contextMenus) {
            return;
        }
        backgroundPage.contextMenus.removeAll();
        if (settings.showContextMenu()) {
            if (prefs.mobile) {
                customizeMobileContextMenu(tab);
            } else {
                customizeContextMenu(tab);
            }
            if (typeof backgroundPage.contextMenus.render === 'function') {
                // In some case we need to manually render context menu
                backgroundPage.contextMenus.render();
            }
        }
    }

    function closeAllPages() {
        tabsApi.forEach((tab) => {
            if (tab.url.indexOf(backgroundPage.getURL('')) >= 0) {
                tabsApi.remove(tab.tabId);
            }
        });
    }

    function getPageUrl(page) {
        return backgroundPage.getURL(`pages/${page}`);
    }

    const isAdguardTab = (tab) => {
        const { url } = tab;
        const parsedUrl = new URL(url);
        const schemeUrl = backgroundPage.app.getUrlScheme();
        return parsedUrl.protocol.indexOf(schemeUrl) > -1;
    };

    const showAlertMessagePopup = async (title, text) => {
        const tab = await tabsApi.getActive();
        if (tab) {
            tabsApi.sendMessage(tab.tabId, {
                type: 'show-alert-popup',
                isAdguardTab: isAdguardTab(tab),
                title,
                text,
            });
        }
    };

    /**
     * Depending on version numbers select proper message for description
     *
     * @param currentVersion
     * @param previousVersion
     */
    function getUpdateDescriptionMessage(currentVersion, previousVersion) {
        if (browserUtils.getMajorVersionNumber(currentVersion) > browserUtils.getMajorVersionNumber(previousVersion)
            || browserUtils.getMinorVersionNumber(currentVersion) > browserUtils.getMinorVersionNumber(previousVersion)) {
            return translator.getMessage('options_popup_version_update_description_major');
        }

        return translator.getMessage('options_popup_version_update_description_minor');
    }

    /**
     * Shows application updated popup
     *
     * @param currentVersion
     * @param previousVersion
     */
    const showVersionUpdatedPopup = async (currentVersion, previousVersion) => {
        const notification = notifications.getCurrentNotification();

        if (!notification
            && browserUtils.getMajorVersionNumber(currentVersion) === browserUtils.getMajorVersionNumber(previousVersion)
            && browserUtils.getMinorVersionNumber(currentVersion) === browserUtils.getMinorVersionNumber(previousVersion)) {
            return;
        }

        let offer = translator.getMessage('options_popup_version_update_offer');
        let offerButtonHref = 'https://adguard.com/forward.html?action=learn_about_adguard&from=version_popup&app=browser_extension';
        let offerButtonText = translator.getMessage('options_popup_version_update_offer_button_text');

        if (notification) {
            offer = notification.text.title;
            offerButtonText = notification.text.btn;
            offerButtonHref = `${notification.url}&from=version_popup`;
        }

        const message = {
            type: 'show-version-updated-popup',
            title: translator.getMessage('options_popup_version_update_title_text', { current_version: currentVersion }),
            description: getUpdateDescriptionMessage(currentVersion, previousVersion),
            changelogHref: 'https://adguard.com/forward.html?action=github_version_popup&from=version_popup&app=browser_extension',
            changelogText: translator.getMessage('options_popup_version_update_changelog_text'),
            showPromoNotification: !!notification,
            offer,
            offerButtonText,
            offerButtonHref,
            disableNotificationText: translator.getMessage('options_popup_version_update_disable_notification'),
        };

        const tab = await tabsApi.getActive();
        if (tab) {
            message.isAdguardTab = isAdguardTab(tab);
            tabsApi.sendMessage(tab.tabId, message);
        }
    };

    function getFiltersUpdateResultMessage(success, updatedFilters) {
        let title = '';
        let text = '';
        if (success && updatedFilters) {
            if (updatedFilters.length === 0) {
                title = '';
                text = translator.getMessage('options_popup_update_not_found');
            } else {
                title = '';
                text = updatedFilters
                    .sort((a, b) => {
                        if (a.groupId === b.groupId) {
                            return a.displayNumber - b.displayNumber;
                        }
                        return a.groupId === b.groupId;
                    })
                    .map(filter => `${filter.name}`)
                    .join(', ');
                if (updatedFilters.length > 1) {
                    text += ` ${translator.getMessage('options_popup_update_filters')}`;
                } else {
                    text += ` ${translator.getMessage('options_popup_update_filter')}`;
                }
            }
        } else {
            title = translator.getMessage('options_popup_update_title_error');
            text = translator.getMessage('options_popup_update_error');
        }

        return {
            title,
            text,
        };
    }

    function getFiltersEnabledResultMessage(enabledFilters) {
        const title = translator.getMessage('alert_popup_filter_enabled_title');
        const text = [];
        enabledFilters.sort((a, b) => a.displayNumber - b.displayNumber);
        for (let i = 0; i < enabledFilters.length; i += 1) {
            const filter = enabledFilters[i];
            text.push(translator.getMessage(
                'alert_popup_filter_enabled_desc',
                { filter_name: filter.name },
            ));
        }
        return {
            title,
            text,
        };
    }

    const updateTabIconAndContextMenu = function (tab, reloadFrameData) {
        if (reloadFrameData) {
            frames.reloadFrameData(tab);
        }
        updateTabIcon(tab);
        updateTabContextMenu(tab);
    };

    const openExportRulesTab = function (hash) {
        openTab(getPageUrl(`export.html#${hash}`));
    };

    /**
     * Open settings tab with hash parameters or without them
     * @param anchor
     * @param hashParameters
     */
    const openSettingsTab = function (anchor, hashParameters = {}) {
        if (anchor) {
            hashParameters.anchor = anchor;
        }

        const options = {
            activateSameTab: true,
            hashParameters,
        };

        openTab(getPageUrl('options.html'), options);
    };

    const openSiteReportTab = function (url) {
        const domain = utils.url.toPunyCode(utils.url.getDomainName(url));
        if (domain) {
            openTab(`https://adguard.com/site.html?domain=${encodeURIComponent(domain)}&utm_source=extension&aid=16593`);
        }
    };

    /**
     * Generates query string with stealth options information
     * @returns {string}
     */
    const getStealthString = () => {
        const stealthOptions = [
            { queryKey: 'ext_hide_referrer', settingKey: settings.HIDE_REFERRER },
            { queryKey: 'hide_search_queries', settingKey: settings.HIDE_SEARCH_QUERIES },
            { queryKey: 'DNT', settingKey: settings.SEND_DO_NOT_TRACK },
            { queryKey: 'x_client', settingKey: settings.BLOCK_CHROME_CLIENT_DATA },
            { queryKey: 'webrtc', settingKey: settings.BLOCK_WEBRTC },
            {
                queryKey: 'third_party_cookies',
                settingKey: settings.SELF_DESTRUCT_THIRD_PARTY_COOKIES,
                settingValueKey: settings.SELF_DESTRUCT_THIRD_PARTY_COOKIES_TIME,
            },
            {
                queryKey: 'first_party_cookies',
                settingKey: settings.SELF_DESTRUCT_FIRST_PARTY_COOKIES,
                settingValueKey: settings.SELF_DESTRUCT_FIRST_PARTY_COOKIES_TIME,
            },
        ];

        const stealthEnabled = !settings.getProperty(settings.DISABLE_STEALTH_MODE);

        if (!stealthEnabled) {
            return `&stealth.enabled=${stealthEnabled}`;
        }

        const stealthOptionsString = stealthOptions.map((option) => {
            const { queryKey, settingKey, settingValueKey } = option;
            const setting = settings.getProperty(settingKey);
            let settingString;
            if (!setting) {
                return '';
            }
            if (!settingValueKey) {
                settingString = setting;
            } else {
                settingString = settings.getProperty(settingValueKey);
            }
            return `stealth.${queryKey}=${encodeURIComponent(settingString)}`;
        })
            .filter(string => string.length > 0)
            .join('&');

        return `&stealth.enabled=${stealthEnabled}&${stealthOptionsString}`;
    };

    /**
     * Generates query string with browsing security information
     * @returns {string}
     */
    const getBrowserSecurityString = () => {
        const isEnabled = !settings.getProperty(settings.DISABLE_SAFEBROWSING);
        return `&browsing_security.enabled=${isEnabled}`;
    };

    /**
     * Appends hash parameters if they exists
     * @param rowUrl
     * @param hashParameters
     * @returns {string} prepared url
     */
    const appendHashParameters = (rowUrl, hashParameters) => {
        if (!hashParameters) {
            return rowUrl;
        }

        if (rowUrl.indexOf('#') > -1) {
            log.warn(`Hash parameters can't be applied to the url with hash: '${rowUrl}'`);
            return rowUrl;
        }

        let hashPart;
        const { anchor } = hashParameters;

        if (anchor) {
            delete hashParameters[anchor];
        }

        const hashString = Object.keys(hashParameters)
            .map(key => `${key}=${hashParameters[key]}`)
            .join('&');

        if (hashString.length <= 0) {
            hashPart = anchor && anchor.length > 0 ? `#${anchor}` : '';
            return rowUrl + hashPart;
        }

        hashPart = anchor && anchor.length > 0 ? `replacement=${anchor}&${hashString}` : hashString;
        hashPart = encodeURIComponent(hashPart);
        return `${rowUrl}#${hashPart}`;
    };

    const openTab = async (url, options = {}) => {
        const {
            activateSameTab,
            inBackground,
            inNewWindow,
            type,
            hashParameters,
        } = options;

        url = appendHashParameters(url, hashParameters);

        const onTabFound = async (tab) => {
            if (tab.url !== url) {
                await tabsApi.reload(tab.tabId, url);
            }
            if (!inBackground) {
                await tabsApi.activate(tab.tabId);
            }
            return tab;
        };

        url = utils.strings.contains(url, '://') ? url : backgroundPage.getURL(url);
        const tabs = await tabsApi.getAll();
        // try to find between opened tabs
        if (activateSameTab) {
            for (let i = 0; i < tabs.length; i += 1) {
                const tab = tabs[i];
                if (utils.url.urlEquals(tab.url, url)) {
                    return onTabFound(tab);
                }
            }
        }

        const tab = await tabsApi.create({
            url,
            type: type || 'normal',
            active: !inBackground,
            inNewWindow,
        });

        return tab;
    };

    /**
     * Opens site complaint report tab
     * https://github.com/AdguardTeam/ReportsWebApp#pre-filling-the-app-with-query-parameters
     * @param url
     */
    const openAbuseTab = function (url) {
        let browser;
        let browserDetails;

        const supportedBrowsers = ['Chrome', 'Firefox', 'Opera', 'Safari', 'IE', 'Edge'];
        if (supportedBrowsers.includes(prefs.browser)) {
            browser = prefs.browser;
        } else {
            browser = 'Other';
            browserDetails = prefs.browser;
        }

        const filterIds = application.getEnabledFiltersFromEnabledGroups()
            .map(filter => filter.filterId);

        openTab(`https://reports.adguard.com/new_issue.html?product_type=Ext&product_version=${
            encodeURIComponent(backgroundPage.app.getVersion())
        }&browser=${encodeURIComponent(browser)
        }${browserDetails ? `&browser_detail=${encodeURIComponent(browserDetails)}` : ''
        }&url=${encodeURIComponent(url)
        }&filters=${encodeURIComponent(filterIds.join('.'))
        }${getStealthString()
        }${getBrowserSecurityString()}`);
    };

    const openFilteringLog = async function (tabId) {
        const FILTERING_LOG_PAGE = 'filtering-log.html';
        const options = { activateSameTab: true, type: 'popup' };

        if (!tabId) {
            const tab = await tabsApi.getActive();
            if (tab) {
                const { tabId } = tab;
                await openTab(getPageUrl(FILTERING_LOG_PAGE) + (tabId ? `#${tabId}` : ''), options);
            }
            return;
        }

        await openTab(getPageUrl(FILTERING_LOG_PAGE) + (tabId ? `#${tabId}` : ''), options);
    };

    /**
     * Opens user rules editor in the separate window in fullscreen
     * @return {Promise<void>}
     */
    const openFullscreenUserRules = async () => {
        const theme = settings.getProperty('appearance-theme');
        const FULLSCREEN_USER_RULES_PAGE = `fullscreen-user-rules.html?theme=${theme}`;
        const options = { activateSameTab: true, inNewWindow: true };
        await openTab(getPageUrl(FULLSCREEN_USER_RULES_PAGE), options);
    };

    const openThankYouPage = async () => {
        const params = browserUtils.getExtensionParams();
        params.push(`_locale=${encodeURIComponent(backgroundPage.app.getLocale())}`);
        const thankyouUrl = `${THANKYOU_PAGE_URL}?${params.join('&')}`;

        // TODO move url in constants
        const filtersDownloadUrl = getPageUrl('filter-download.html');

        const tabs = await tabsApi.getAll();

        // Finds the filter-download page and reload it within the thank-you page URL
        for (let i = 0; i < tabs.length; i += 1) {
            const tab = tabs[i];
            if (tab.url === filtersDownloadUrl) {
                // In YaBrowser don't activate found page
                if (!browserUtils.isYaBrowser()) {
                    tabsApi.activate(tab.tabId);
                }
                tabsApi.reload(tab.tabId, thankyouUrl);
                return;
            }
        }

        await openTab(thankyouUrl);
    };

    const openExtensionStore = async function () {
        await openTab(extensionStoreLink);
    };

    const openFiltersDownloadPage = function () {
        openTab(getPageUrl('filter-download.html'), { inBackground: browserUtils.isYaBrowser() });
    };

    const openCustomFiltersModal = async (url, title) => {
        let path = 'options.html#filters?group=0';
        if (title) {
            path += `&title=${title}`;
        }
        path += `&subscribe=${encodeURIComponent(url)}`;

        const tab = await openTab(getPageUrl(path), { activateSameTab: true });
        await tabsApi.reload(tab.tabId);
    };

    const allowlistTab = function (tab) {
        const tabInfo = frames.getFrameInfo(tab);
        allowlist.allowlistUrl(tabInfo.url);
        updateTabIconAndContextMenu(tab, true);
        tabsApi.reload(tab.tabId);
    };

    const unAllowlistTab = function (tab) {
        const tabInfo = frames.getFrameInfo(tab);
        userrules.unAllowlistFrame(tabInfo);
        updateTabIconAndContextMenu(tab, true);
        tabsApi.reload(tab.tabId);
    };

    const changeApplicationFilteringDisabled = async function (disabled) {
        settings.changeFilteringDisabled(disabled);
        const tab = await tabsApi.getActive();
        if (tab) {
            updateTabIconAndContextMenu(tab, true);
            tabsApi.reload(tab.tabId);
        }
    };

    /**
     * Checks filters updates and returns updated filter
     * @param {Object[]} [filters] optional list of filters
     * @param {boolean} [showPopup = true] show update filters popup
     * @return {Object[]} [filters] list of updated filters
     */
    const checkFiltersUpdates = async (filters, showPopup = true) => {
        const showPopupEvent = listeners.UPDATE_FILTERS_SHOW_POPUP;

        try {
            const updatedFilters = await application.checkFiltersUpdates(filters);
            if (showPopup) {
                listeners.notifyListeners(showPopupEvent, true, updatedFilters);
                listeners.notifyListeners(listeners.FILTERS_UPDATE_CHECK_READY, updatedFilters);
            } else if (updatedFilters && updatedFilters.length > 0) {
                const updatedFilterStr = updatedFilters.map(f => `Filter ID: ${f.filterId}`).join(', ');
                log.info(`Filters were auto updated: ${updatedFilterStr}`);
            }
            return updatedFilters;
        } catch (e) {
            if (showPopup) {
                listeners.notifyListeners(showPopupEvent, false);
                listeners.notifyListeners(listeners.FILTERS_UPDATE_CHECK_READY);
            }
            return [];
        }
    };

    const initAssistant = async (selectElement) => {
        const options = {
            addRuleCallbackName: MESSAGE_TYPES.ADD_USER_RULE,
            selectElement,
        };

        // init assistant
        const tab = await tabsApi.getActive();
        if (tab) {
            tabsApi.sendMessage(tab.tabId, {
                type: 'initAssistant',
                options,
            });
        }
    };

    /**
     * The `openAssistant` function uses the `tabs.executeScript` function to inject
     * the Assistant code into a page without using messaging.
     * We do it dynamically and not include assistant file into the default content scripts
     * in order to reduce the overall memory usage.
     *
     * @param {boolean} selectElement - if true select the element on which the Mousedown event was
     */
    const openAssistant = async (selectElement) => {
        // Load Assistant code to the activate tab immediately
        await tabsApi.executeScriptFile(null, { file: '/pages/assistant.js' });
        initAssistant(selectElement);
    };

    const init = () => {
        // update icon on event received
        listeners.addListener((event, tab, reset) => {
            if (event !== listeners.UPDATE_TAB_BUTTON_STATE || !tab) {
                return;
            }

            let options;
            if (reset) {
                options = { icon: prefs.ICONS.ICON_GREEN, badge: '' };
            }

            updateTabIcon(tab, options);
        });

        // Update tab icon and context menu while loading
        tabsApi.onUpdated.addListener(async (tab) => {
            const { tabId } = tab;
            // BrowserAction is set separately for each tab
            updateTabIcon(tab);
            const aTab = await tabsApi.getActive();
            if (aTab) {
                if (aTab.tabId !== tabId) {
                    return;
                }
                // ContextMenu is set for all tabs, so update it only for current tab
                updateTabContextMenu(aTab);
            }
        });

        // Update tab icon and context menu on active tab changed
        tabsApi.onActivated.addListener((tab) => {
            updateTabIconAndContextMenu(tab, true);
        });

        // Update icon and popup stats on ads blocked
        listeners.addListener(async (event, rule, tab, blocked) => {
            if (event !== listeners.ADS_BLOCKED || !tab) {
                return;
            }

            pageStats.updateStats(rule.getFilterListId(), blocked, new Date());
            const tabBlocked = frames.updateBlockedAdsCount(tab, blocked);
            if (tabBlocked === null) {
                return;
            }
            updateTabIconAsync(tab);

            const activeTab = await tabsApi.getActive();
            if (activeTab) {
                if (tab.tabId === activeTab.tabId) {
                    updatePopupStatsAsync(activeTab);
                }
            }
        });

        // Update context menu on change user settings
        settings.onUpdated.addListener(async (setting) => {
            if (setting === settings.DISABLE_SHOW_CONTEXT_MENU) {
                const tab = await tabsApi.getActive();
                if (tab) {
                    updateTabContextMenu(tab);
                }
            }
        });

        // Update tab icon and context menu on application initialization
        listeners.addListener(async (event) => {
            if (event === listeners.APPLICATION_INITIALIZED) {
                const tab = await tabsApi.getActive();
                if (tab) {
                    updateTabIconAndContextMenu(tab);
                }
            }
        });

        // on application updated event
        listeners.addListener((event, info) => {
            if (event === listeners.APPLICATION_UPDATED) {
                if (settings.isShowAppUpdatedNotification()) {
                    showVersionUpdatedPopup(info.currentVersion, info.prevVersion);
                }
            }
        });

        // on filter auto-enabled event
        listeners.addListener((event, enabledFilters) => {
            if (event === listeners.ENABLE_FILTER_SHOW_POPUP) {
                const result = getFiltersEnabledResultMessage(enabledFilters);
                showAlertMessagePopup(result.title, result.text);
            }
        });

        // on filter enabled event
        listeners.addListener((event, payload) => {
            switch (event) {
                case listeners.FILTER_ENABLE_DISABLE:
                    if (payload.enabled) {
                        checkFiltersUpdates([payload], false);
                    }
                    break;
                case listeners.FILTER_GROUP_ENABLE_DISABLE:
                    if (payload.enabled && payload.filters) {
                        const enabledFilters = payload.filters.filter(f => f.enabled);
                        checkFiltersUpdates(enabledFilters, false);
                    }
                    break;
                default:
                    break;
            }
        });

        // on filters updated event
        listeners.addListener((event, success, updatedFilters) => {
            if (event === listeners.UPDATE_FILTERS_SHOW_POPUP) {
                const result = getFiltersUpdateResultMessage(success, updatedFilters);
                showAlertMessagePopup(result.title, result.text);
            }
        });

        // close all page on unload
        unload.when(closeAllPages);
    };

    return {
        init,
        openExportRulesTab,
        openSettingsTab,
        openSiteReportTab,
        openFilteringLog,
        openFullscreenUserRules,
        openThankYouPage,
        openExtensionStore,
        openFiltersDownloadPage,
        openCustomFiltersModal,
        openAbuseTab,

        updateTabIconAndContextMenu,

        allowlistTab,
        unAllowlistTab,

        changeApplicationFilteringDisabled,
        checkFiltersUpdates,
        openAssistant,
        openTab,

        showAlertMessagePopup,
    };
})();
