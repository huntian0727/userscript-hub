// ==UserScript==
// @name         98堂_资源一键快速下载(115)
// @namespace    http://tampermonkey.net/
// @version      1.15.0
// @description  一键115下载、复制主题、TXT附件预览、查看下载定位与115云解压密码池；兼容98助手及蚂蚁定位脚本
// @author       yelc668
// @match        *://*.115.com/*
// @include      https://www.sehuatang.*
// @include      https://www.weterytrtrr.*
// @include      https://www.qweqwtret.*
// @include      https://www.retreytryuyt.*
// @include      https://www.qwerwrrt.*
// @include      https://www.5aylp.*
// @include      https://dmn12.*
// @include      https://www.0krgb.*
// @include      https://www.1qyqs.*
// @include      https://www.ds5hk.*
// @include      https://sehuatang.*
// @include      https://weterytrtrr.*
// @include      https://qweqwtret.*
// @include      https://retreytryuyt.*
// @include      https://qwerwrrt.*
// @include      https://5aylp.*
// @include      https://jq2t4.*
// @include      https://plwt.*
// @include      https://ds5hk.*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @grant        GM_cookie
// @grant        GM_setClipboard
// @grant        unsafeWindow
// @connect      115.com
// @connect      webapi.115.com
// @connect      *
// @run-at       document-idle
// @downloadURL https://update.greasyfork.org/scripts/601796/98%E5%A0%82_%E8%B5%84%E6%BA%90%E4%B8%80%E9%94%AE%E5%BF%AB%E9%80%9F%E4%B8%8B%E8%BD%BD%28115%29.user.js
// @updateURL https://update.greasyfork.org/scripts/601796/98%E5%A0%82_%E8%B5%84%E6%BA%90%E4%B8%80%E9%94%AE%E5%BF%AB%E9%80%9F%E4%B8%8B%E8%BD%BD%28115%29.meta.js
// ==/UserScript==

;(function () {
  const config = {
    webDownloadFolderId: GM_getValue('webDownloadFolderId', ''),
    botDownloadUrl: GM_getValue('botDownloadUrl', ''),
    signUrl: 'https://115.com/?ct=offline&ac=space&_=', // 获取115 token签名接口
    addTaskUrl: 'https://115.com/web/lixian/?ct=lixian&ac=add_task_url', // 添加115离线任务接口
    addTaskUrls: 'https://115.com/web/lixian/?ct=lixian&ac=add_task_urls', // 添加115b多个离线任务接口
    getUserUrl: 'https://webapi.115.com/offine/downpath', // 获取115用户userid接口
  }
  let requireCookieNames = ['UID', 'CID', 'SEID']

  // 每个代码框/附件预览独立绑定链接，普通正文中的链接单独作为本楼补充入口。
  const addonOwnUI = '#tm-115-global-actions, .tm-115-download-actions, .tm-115-post-actions, .tm115-txt-controls, .search_dw, #tm-115-settings, #tm-115-toast, #tm-115-title-settings'
  const codeContainerSelector = '.blockcode, pre, code'
  const downloadScopes = new Map()
  const txtAttachmentPreviews = new Map()
  const locatorButtons = new WeakSet()
  let lastDownloadLocation = null
  let locatorRevision = 0
  let locatorHighlight = null
  const attachmentPreviewSelector = [
    '.preview-content', '.preview-body', '.txt-content', '.file-content',
    '[class*="preview" i]', '[id*="preview" i]', '.tm115-txt-content', 'pre', 'code'
  ].join(', ')
  const ignoredLinkContainer = 'script,style,textarea,input,select,option,noscript,[contenteditable="true"]'
  let linkScanTimer = null
  const defaultTopicKeywords = '自转\n115\n百度\nGB\n配额\n迅雷\n夸克\nED2K\nBT\nsha1\n破解\n磁力\n磁链'
  const topicBracketPairs = new Map([
    ['【', '】'], ['[', ']'], ['(', ')'], ['（', '）'], ['{', '}'], ['<', '>'],
    ['［', '］'], ['｛', '｝'], ['＜', '＞'], ['《', '》'], ['〈', '〉'],
    ['「', '」'], ['『', '』'], ['〔', '〕'], ['〖', '〗'], ['〘', '〙'],
    ['〚', '〛'], ['｟', '｠'], ['｢', '｣']
  ])
  const topicBracketClosers = new Set(topicBracketPairs.values())

  function getTxtAttachmentName(link) {
    let url
    try { url = new URL(link.href, location.href) } catch (_) { return '' }
    if (!/^https?:$/.test(url.protocol) ||
        (url.searchParams.get('mod') !== 'attachment' && !/\/attachment\.php$/i.test(url.pathname))) return ''
    return [link.textContent, link.getAttribute('title'), link.getAttribute('download')]
      .map((value) => String(value || '').replace(/\s+/g, ' ').trim())
      .find((value) => /\.txt$/i.test(value)) || ''
  }

  function resetTxtAttachmentPreview(record) {
    record.generation++
    record.request?.abort?.()
    record.request = null
    record.box?.remove()
    record.box = null
    record.state = 'closed'
    record.button.textContent = '[预览内容]'
    record.button.title = '预览TXT附件内容'
    record.button.setAttribute('aria-expanded', 'false')
  }

  function initTxtAttachmentPreviews() {
    for (const [link, record] of txtAttachmentPreviews) {
      const name = link.isConnected ? getTxtAttachmentName(link) : ''
      if (!name || !record.controls.isConnected) {
        resetTxtAttachmentPreview(record)
        record.controls.remove()
        if (link.dataset.tm115TxtOwner === '1') {
          delete link.dataset.tm115TxtOwner
          delete link.dataset.hasPreviewBtn
        }
        txtAttachmentPreviews.delete(link)
        continue
      }
      if (record.url !== link.href || record.name !== name) {
        resetTxtAttachmentPreview(record)
        record.url = link.href
        record.name = name
      }
      const anchor = link.closest('.attnm') || link
      if (anchor.nextElementSibling !== record.controls) anchor.insertAdjacentElement('afterend', record.controls)
      if (record.box) {
        // 预览不能放回附件行：Discuz附件的p/dd常有限高或overflow:hidden。
        if (record.box.parentElement !== document.body) document.body.appendChild(record.box)
        positionTxtAttachmentPreview(record)
      }
    }
    document.querySelectorAll('a[href]').forEach((link) => {
      if (link.closest(addonOwnUI + ', .quote, blockquote, .sign, ' + ignoredLinkContainer) || txtAttachmentPreviews.has(link)) return
      const name = getTxtAttachmentName(link)
      // 98助手 3.0.0 也检查这个 DOM 标记；两个脚本无论谁先运行，都只添加一个入口。
      if (!name || link.dataset.hasPreviewBtn) return
      link.dataset.hasPreviewBtn = 'true'
      link.dataset.tm115TxtOwner = '1'
      const controls = document.createElement('span')
      controls.className = 'tm115-txt-controls'
      controls.style.cssText = 'display:inline-block;margin-left:8px;vertical-align:middle;'
      const button = document.createElement('button')
      button.type = 'button'
      button.style.cssText = 'border:0;padding:2px 4px;background:transparent;color:#1677ff;font:inherit;cursor:pointer;'
      controls.appendChild(button)
      const record = { link, name, url: link.href, controls, button, box: null, request: null, generation: 0, state: 'closed' }
      resetTxtAttachmentPreview(record)
      button.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (record.state === 'loading' || record.state === 'open') {
          resetTxtAttachmentPreview(record)
          findLinksAndCreateButtons()
        } else loadTxtAttachmentPreview(record)
      })
      txtAttachmentPreviews.set(link, record)
      // 文件名行自身也可能限高，入口放在该行外，避免长文件名挤掉预览按钮。
      const anchor = link.closest('.attnm') || link
      anchor.insertAdjacentElement('afterend', controls)
    })
  }

  function decodeTxtAttachment(buffer) {
    if (!buffer || (typeof buffer !== 'string' && !buffer.byteLength)) throw new Error('附件内容为空')
    let text
    if (typeof buffer === 'string') text = buffer
    else {
      const bytes = new Uint8Array(buffer)
      if (bytes[0] === 255 && bytes[1] === 254) text = new TextDecoder('utf-16le').decode(bytes)
      else if (bytes[0] === 254 && bytes[1] === 255) text = new TextDecoder('utf-16be').decode(bytes)
      else {
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
        catch (_) { text = new TextDecoder('gbk').decode(bytes) }
      }
    }
    text = text.replace(/^\uFEFF/, '')
    if (!text.trim()) throw new Error('附件内容为空')
    const htmlPage = /^\s*(?:<!doctype\s+html|<html\b|<head\b|<body\b)/i.test(text)
    if (htmlPage || /alert_error|alert_info|messagetext/.test(text)) {
      const doc = new DOMParser().parseFromString(text, 'text/html')
      const message = doc.querySelector('.alert_error, .alert_info, .alert_btnleft, #messagetext')?.textContent.trim()
      if (message) throw new Error(message)
      if (htmlPage) throw new Error('返回的是网页，请检查登录状态或附件权限' + (doc.title ? `（${doc.title}）` : ''))
    }
    return text
  }

  function loadTxtAttachmentPreview(record) {
    if (!record.link.isConnected) return
    record.url = record.link.href
    const url = record.url
    const generation = ++record.generation
    record.state = 'loading'
    record.button.textContent = '[取消加载]'
    record.button.title = '正在加载TXT附件，点击可取消'
    const isCurrent = () => txtAttachmentPreviews.get(record.link) === record && record.link.isConnected &&
      record.link.href === url && record.generation === generation && record.state === 'loading'
    const fail = (message) => {
      if (!isCurrent()) return
      record.request = null
      record.state = 'error'
      record.button.textContent = '[预览失败，点击重试]'
      record.button.title = message
      customNotify('TXT预览失败：' + message)
    }
    try {
      const request = GM_xmlhttpRequest({
        method: 'GET', url, responseType: 'arraybuffer', timeout: 20000, anonymous: false,
        headers: { Referer: location.href, Accept: 'text/plain,*/*;q=0.8' },
        onload: (response) => {
          if (!isCurrent()) return
          if (response.status < 200 || response.status >= 300) { fail(`HTTP ${response.status}，请检查登录状态或附件权限`); return }
          try {
            const text = decodeTxtAttachment(response.response)
            record.request = null
            showTxtAttachmentPreview(record, text)
          } catch (error) { fail(error?.message || String(error)) }
        },
        onerror: () => fail('网络请求失败，请稍后重试'),
        ontimeout: () => fail('请求超时，请重试'),
        onabort: () => fail('请求已中止，请重试'),
      })
      if (isCurrent()) record.request = request
    } catch (error) { fail(error?.message || String(error)) }
  }

  function showTxtAttachmentPreview(record, text) {
    record.box?.remove()
    const box = document.createElement('div')
    box.className = 'tm115-txt-panel'
    box.style.cssText = 'position:fixed!important;z-index:2147483600!important;display:flex!important;flex-direction:column!important;box-sizing:border-box!important;min-width:0!important;min-height:0!important;max-width:calc(100vw - 24px)!important;margin:0!important;padding:0!important;border:1px solid #777!important;border-radius:6px!important;background:#181a1b!important;color:#ddd!important;text-align:left!important;overflow:hidden!important;box-shadow:0 8px 28px rgba(0,0,0,.45)!important;'
    box.setAttribute('role', 'region')
    box.setAttribute('aria-label', 'TXT预览：' + record.name)
    const header = document.createElement('div')
    header.className = 'tm115-txt-controls'
    header.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 10px;border-bottom:1px solid #555;flex-shrink:0;'
    const copy = createStyledButton('复制全部', '#1677ff', '#4096ff')
    copy.type = 'button'
    copy.style.cssText += 'font-size:14px;padding:6px 10px;flex-shrink:0;margin:0;'
    copy.addEventListener('click', async () => {
      try {
        await GM_setClipboard(text, 'text')
        copy.textContent = '已复制'
        setTimeout(() => { if (copy.isConnected) copy.textContent = '复制全部' }, 2000)
      } catch (error) { customNotify('复制附件内容失败：' + (error?.message || error)) }
    })
    const title = document.createElement('span')
    title.textContent = record.name
    title.title = record.name
    title.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;'
    const close = document.createElement('button')
    close.type = 'button'
    close.textContent = '×'
    close.title = '关闭预览'
    close.style.cssText = 'border:0;background:transparent;color:#ddd;font-size:24px;cursor:pointer;'
    close.addEventListener('click', () => { resetTxtAttachmentPreview(record); findLinksAndCreateButtons(); record.button.focus() })
    header.append(copy, title, close)
    const content = document.createElement('div')
    content.className = 'tm115-txt-content'
    content.textContent = text
    content.style.cssText = 'padding:12px;min-height:0;max-height:360px;flex:1 1 auto;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.6 Consolas,"Microsoft YaHei",monospace;'
    box.append(header, content)
    document.body.appendChild(box)
    record.box = box
    record.state = 'open'
    record.button.textContent = '[关闭预览]'
    record.button.title = '关闭TXT预览'
    record.button.setAttribute('aria-expanded', 'true')
    findLinksAndCreateButtons()
    positionTxtAttachmentPreview(record)
  }

  function positionTxtAttachmentPreview(record) {
    const box = record.box
    if (!box?.isConnected || !record.controls.isConnected) return
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight
    const margin = 12
    const width = Math.max(0, Math.min(960, viewportWidth - margin * 2))
    const maxHeight = Math.max(0, Math.min(560, viewportHeight - margin * 2))
    // 只写入变化的值，避免自身样式变化持续触发页面扫描。
    const setStyle = (name, value) => {
      if (box.style.getPropertyValue(name) !== value || box.style.getPropertyPriority(name) !== 'important') box.style.setProperty(name, value, 'important')
    }
    setStyle('width', `${width}px`)
    setStyle('max-height', `${maxHeight}px`)
    const anchor = record.controls.getBoundingClientRect()
    const height = Math.min(box.getBoundingClientRect().height || 360, maxHeight)
    const left = Math.max(margin, Math.min(anchor.left, viewportWidth - width - margin))
    const below = anchor.bottom + 8
    const preferredTop = below + height <= viewportHeight - margin ? below : anchor.top - height - 8
    const top = Math.max(margin, Math.min(preferredTop, viewportHeight - height - margin))
    setStyle('left', `${Math.round(left)}px`)
    setStyle('top', `${Math.round(top)}px`)
  }

  function startTxtPreviewPositioning() {
    let scheduled = false
    const reposition = () => {
      if (scheduled || ![...txtAttachmentPreviews.values()].some((record) => record.box)) return
      scheduled = true
      requestAnimationFrame(() => {
        scheduled = false
        for (const record of txtAttachmentPreviews.values()) positionTxtAttachmentPreview(record)
      })
    }
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
  }

  function getDownloadLocations() {
    const codeRoots = getCodeContainers().filter((node) => isDownloadLocationVisible(node) && getCleanLinkText(node).trim())
    const attachments = new Map()
    const targets = [...codeRoots]
    for (const link of document.querySelectorAll('a[href]')) {
      if (!isDownloadLocationVisible(link) || codeRoots.some((node) => node.contains(link))) continue
      let url
      try { url = new URL(link.href, location.href) } catch (_) { continue }
      const attachment = url.searchParams.get('mod') === 'attachment' || /\/attachment\.php$/i.test(url.pathname) ||
        /^aid\d+$/i.test(link.id) || !!link.closest('span[id^="attach_"], div.attach[id^="attach_"]')
      if (attachment) {
        // 同一个附件常同时有图标链接和文件名链接，优先定位到文件名。
        const key = url.searchParams.get('aid') || link.href
        const previous = attachments.get(key)
        if (!previous || (!previous.textContent.trim() && link.textContent.trim())) attachments.set(key, link)
      } else if (/^(?:ed2k:\/\/|magnet:\?|thunder:\/\/)/i.test(link.getAttribute('href') || '')) targets.push(link)
    }
    targets.push(...attachments.values())
    // 补充没有代码框或超链接的纯文本资源，定位到其所在段落。
    const posts = getForumPostRoots()
    if (!posts.length && getMainPostRoot()) posts.push(getMainPostRoot())
    for (const post of posts) {
      const walker = document.createTreeWalker(post, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) {
        const text = walker.currentNode
        if (!/(?:ed2k:\/\/|magnet:\?)/i.test(text.nodeValue || '')) continue
        const parent = text.parentElement
        if (!parent || parent.closest('a, ' + codeContainerSelector) || !isDownloadLocationVisible(parent)) continue
        const paragraph = parent.closest('p, li, td, .t_f, .pcb, .postmessage') || parent
        if (!targets.includes(paragraph)) targets.push(paragraph)
      }
    }
    return [...new Set(targets)].sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_PRECEDING ? 1 : -1)
  }

  function isDownloadLocationVisible(element) {
    return !element.closest(addonOwnUI + ', .quote, blockquote, .sign, .tm115-txt-panel, .txt-preview-box, ' + ignoredLinkContainer) &&
      isVisibleAttachmentPreview(element)
  }

  function clearDownloadLocationHighlight() {
    if (!locatorHighlight) return
    clearTimeout(locatorHighlight.timer)
    const { element, outline, outlinePriority, offset, offsetPriority, appliedOutline } = locatorHighlight
    if (element.style.getPropertyValue('outline') === appliedOutline) {
      if (outline) element.style.setProperty('outline', outline, outlinePriority)
      else element.style.removeProperty('outline')
      if (offset) element.style.setProperty('outline-offset', offset, offsetPriority)
      else element.style.removeProperty('outline-offset')
    }
    locatorHighlight = null
  }

  function scrollToDownloadLocation(element) {
    element.scrollIntoView({ block: 'start', behavior: 'auto' })
    window.scrollBy({ top: -100, behavior: 'auto' })
  }

  function locateNextDownload(button) {
    const revision = ++locatorRevision
    const targets = getDownloadLocations()
    if (!targets.length) {
      lastDownloadLocation = null
      clearDownloadLocationHighlight()
      customNotify('此页没有找到下载链接或附件')
      return
    }
    const index = (targets.indexOf(lastDownloadLocation) + 1) % targets.length
    const target = targets[index]
    lastDownloadLocation = target
    clearDownloadLocationHighlight()
    const previous = {
      element: target,
      outline: target.style.getPropertyValue('outline'), outlinePriority: target.style.getPropertyPriority('outline'),
      offset: target.style.getPropertyValue('outline-offset'), offsetPriority: target.style.getPropertyPriority('outline-offset'),
    }
    target.style.setProperty('outline', '#1677ff solid 3px', 'important')
    target.style.setProperty('outline-offset', '4px', 'important')
    previous.appliedOutline = target.style.getPropertyValue('outline')
    previous.timer = setTimeout(clearDownloadLocationHighlight, 1500)
    locatorHighlight = previous
    scrollToDownloadLocation(target)
    // 图片懒加载引起布局位移时重新对齐同一目标；连续点击时旧回调自动失效。
    setTimeout(() => {
      if (revision === locatorRevision && target.isConnected && isDownloadLocationVisible(target)) scrollToDownloadLocation(target)
    }, 180)
    button.title = `查看下载：已定位 ${index + 1}/${targets.length}，再次点击跳转到下一个位置`
    customNotify(`查看下载：${index + 1}/${targets.length}`)
  }

  function initDownloadLocator() {
    let button = document.querySelector('.search_dw')
    if (!button && !getMainPostRoot() && !document.querySelector('#postlist') && !/thread-\d+|mod=viewthread|[?&]tid=\d+/.test(location.href)) return
    if (!document.getElementById('tm-115-settings')) createSettingButton()
    const settings = document.getElementById('tm-115-settings')
    if (!button) button = createStyledButton('查看下载')
    if (!locatorButtons.has(button)) {
      const style = createStyledButton('查看下载')
      button.style.cssText = style.style.cssText
      button.onmouseover = style.onmouseover
      button.onmouseout = style.onmouseout
      button.classList.add('search_dw', 'tm115-find-download')
      button.textContent = '查看下载'
      button.title = '依次定位本页下载链接、代码框和附件，再次点击跳转到下一个位置'
      if (button.tagName === 'BUTTON') button.type = 'button'
      else {
        button.setAttribute('role', 'button')
        button.tabIndex = 0
        button.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopImmediatePropagation(); button.click() }
        }, true)
      }
      // 蚂蚁脚本会复用 .search_dw，却仍会绑定冒泡事件。
      // 捕获阶段统一接管，兼容任意加载顺序，避免一次点击执行两套跳转。
      button.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopImmediatePropagation()
        locateNextDownload(button)
      }, true)
      locatorButtons.add(button)
    }
    if (settings.firstElementChild !== button) settings.prepend(button)
  }

  function extractAttachmentLinks(text) {
    if (typeof text !== 'string' || !/(?:ed2k:|magnet:)/i.test(text)) return []
    const ed2k = text.match(/ed2k:\/\/\|file\|[^|\r\n<>]+\|\d+\|[a-f0-9]{16,40}\|\//gi) || []
    const magnet = text.match(/magnet:\?[^\s<>"']+/gi) || []
    return [...new Set([...ed2k, ...magnet].map((value) =>
      value.replace(/&amp;/g, '&').replace(/[，。,；;]+$/, '').trim()
    ).filter(Boolean))]
  }

  function getCleanLinkText(element, excludedRoots = []) {
    if (!element) return ''
    const clone = element.cloneNode(true)
    // 克隆节点不保留布局，必须用原节点判断预览是否隐藏。
    const visibilitySelectors = attachmentPreviewSelector + ', .blockcode, [hidden], [aria-hidden="true"], [style], .hide, .hidden'
    const originals = [...element.querySelectorAll('*')]
    const copies = [...clone.querySelectorAll('*')]
    const excluded = new Set(excludedRoots)
    originals.forEach((node, index) => {
      if (excluded.has(node) || (node.matches(visibilitySelectors) && !isVisibleAttachmentPreview(node))) copies[index].remove()
    })
    clone.querySelectorAll(addonOwnUI + ', button, [role="button"], .quote, blockquote, .sign, ' + ignoredLinkContainer).forEach((node) => node.remove())
    clone.querySelectorAll('a, span, em, strong, div, p').forEach((node) => {
      const label = (node.textContent || '').replace(/\s+/g, ' ').trim()
      if (/^(?:复制代码|复制全部|关闭预览|\[关闭预览\])$/.test(label)) node.remove()
    })
    // 克隆节点的 textContent 不保留块级换行，避免相邻磁力链接被拼成一条。
    clone.querySelectorAll('br').forEach((node) => node.replaceWith('\n'))
    clone.querySelectorAll('div, p, pre, li, section, tr').forEach((node) => {
      node.prepend('\n')
      node.append('\n')
    })
    return clone.innerText || clone.textContent || ''
  }

  function getForumPostRoots() {
    const list = document.querySelector('#postlist')
    const scope = list || document
    const numbered = [...scope.querySelectorAll('[id^="post_"]')].filter((node) => /^post_\d+$/.test(node.id))
    if (numbered.length) return numbered
    return [...scope.querySelectorAll('.plhin, .pcht, .post')].filter((node, _, all) =>
      !all.some((other) => other !== node && other.contains(node)))
  }

  function getMainPostRoot() {
    const firstNumberedPost = getForumPostRoots()[0]
    if (firstNumberedPost) return firstNumberedPost
    const postList = document.querySelector('#postlist')
    if (postList) {
      // Discuz 页面通常按 DOM 顺序排列帖子；优先取帖子列表中的第一个帖子容器
      const directChildren = [...postList.children]
      const firstPost = directChildren.find((element) =>
        /^post_\d+/i.test(element.id || '') ||
        element.matches('.plhin, .pcht, .post') ||
        !!element.querySelector('.pcb, .t_f, .postmessage, .blockcode')
      )
      if (firstPost) return firstPost
      const nestedPost = postList.querySelector('[id^="post_"]')
      if (nestedPost) return nestedPost
    }

    const knownPost = document.querySelector('#post_1, [id^="post_"]')
    if (knownPost) return knownPost

    return document.querySelector('.pcb, .t_f, .postmessage, .thread-content, .post-content, .blockcode') || null
  }

  function isVisibleAttachmentPreview(element) {
    if (!element || !element.isConnected) return false
    try {
      for (let node = element; node; node = node.parentElement) {
        const style = window.getComputedStyle(node)
        if (node.hidden || node.getAttribute('aria-hidden') === 'true' ||
            style.display === 'none' || style.visibility === 'hidden' ||
            style.visibility === 'collapse') return false
      }
      return element.getClientRects().length > 0
    } catch (_) {
      return false
    }
  }

  function getVisibleAttachmentPreviews() {
    const mainPost = getMainPostRoot()
    const candidates = new Set(document.querySelectorAll(attachmentPreviewSelector))
    // 兼容无固定类名的预览：从“复制全部/关闭预览”控件定位邻近内容容器。
    document.querySelectorAll('button, a, [role="button"]').forEach((control) => {
      if (control.closest(addonOwnUI) || !isVisibleAttachmentPreview(control)) return
      if (!/^(?:复制全部|关闭预览|\[关闭预览\])$/.test((control.textContent || '').trim())) return
      let parent = control.parentElement
      for (let depth = 0; parent && depth < 4; depth++, parent = parent.parentElement) {
        if (parent === document.body || parent === mainPost || parent.matches('#postlist, [id^="post_"]')) break
        if (extractAttachmentLinks(getCleanLinkText(parent)).length) {
          candidates.add(parent)
          break
        }
      }
    })
    return [...candidates].filter((element) => {
      if (element.closest(addonOwnUI + ', .quote, blockquote, .sign') || element.closest(ignoredLinkContainer) ||
          !isVisibleAttachmentPreview(element)) return false
      // 普通回复代码块不属于附件预览；明确的 preview 容器仍可独立识别。
      if (element.matches('pre, code')) {
        const post = element.closest('[id^="post_"]')
        if (post && mainPost && post !== mainPost && !mainPost.contains(post) &&
            !element.closest('[class*="preview" i], [id*="preview" i]')) return false
      }
      return extractAttachmentLinks(getCleanLinkText(element)).length > 0
    }).filter((element, _, all) => !all.some((other) => other !== element && element.contains(other)))
  }

  function hasOpenTxtAttachmentPreview() {
    // 本脚本与98助手的已打开TXT窗口；纯文本预览即使没有下载链接也保留设置入口。
    return [...document.querySelectorAll('.tm115-txt-panel, .txt-preview-box')].some((element) =>
      !element.closest('.quote, blockquote, .sign, ' + ignoredLinkContainer) && isVisibleAttachmentPreview(element))
  }

  function canonicalLinkKey(link) {
    const value = String(link || '').replace(/&amp;/g, '&').trim()
    if (/^magnet:\?/i.test(value)) {
      const btih = value.match(/[?&]xt=urn:btih:([^&]+)/i)
      if (btih) {
        let hash = btih[1]
        try { hash = decodeURIComponent(hash) } catch (_) {}
        // 相同 BTIH 即同一资源；忽略 dn、tracker 等附加参数，仅用于去重，不修改实际提交链接
        return `magnet:btih:${normalizeBtih(hash)}`
      }
      const btmh = value.match(/[?&]xt=urn:btmh:([^&]+)/i)
      if (btmh) {
        let hash = btmh[1]
        try { hash = decodeURIComponent(hash) } catch (_) {}
        return `magnet:btmh:${hash.toLowerCase()}`
      }
      return `magnet:${value.replace(/[，。,；;)\]】]+$/, '').toLowerCase()}`
    }
    const ed2k = value.match(/^ed2k:\/\/\|file\|([^|]+)\|(\d+)\|([a-f0-9]+)\|\//i)
    if (ed2k) return `ed2k:${ed2k[2]}:${ed2k[3].toLowerCase()}`
    return value.replace(/[，。,；;)\]】]+$/, '').toLowerCase()
  }

  function normalizeBtih(value) {
    const hash = String(value || '').trim()
    if (!/^[a-z2-7]{32}$/i.test(hash)) return hash.toLowerCase()
    // BTIH 可以是 32 位 Base32 或 40 位十六进制，统一后比较同一资源。
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
    let bits = 0, buffer = 0, hex = ''
    for (const char of hash.toUpperCase()) {
      buffer = (buffer << 5) | alphabet.indexOf(char)
      bits += 5
      if (bits >= 8) {
        bits -= 8
        hex += ((buffer >> bits) & 255).toString(16).padStart(2, '0')
        buffer &= (1 << bits) - 1
      }
    }
    return hex
  }

  function collectPageLinks(root = getMainPostRoot(), includeDetachedPreviews = true) {
    const found = []
    const addText = (text) => found.push(...extractAttachmentLinks(text || ''))

    if (root) {
      // 只读指定楼层正文，跳过引用、签名、编辑器以及其他楼层。
      const contentSelectors = [
        '.t_f', '.pcb', '.postmessage', '.thread-content', '.post-content',
        '.blockcode', 'pre', 'code', '.preview-content', '.preview-body',
        '.txt-content', '.file-content'
      ].join(', ')
      const contentNodes = [...root.querySelectorAll(contentSelectors)]
        .filter((element) => !element.closest(addonOwnUI) &&
          !element.closest(ignoredLinkContainer + ', .quote, blockquote, .sign') && isVisibleAttachmentPreview(element))
      if (contentNodes.length) {
        contentNodes.forEach((element) => addText(getCleanLinkText(element)))
      } else if (isVisibleAttachmentPreview(root) && !root.querySelector('.quote, blockquote, .sign')) {
        addText(getCleanLinkText(root))
      }

      // 同时读取首帖正文中的 magnet:/ed2k: 超链接
      root.querySelectorAll('a[href]').forEach((anchor) => {
        if (anchor.closest(addonOwnUI + ', .quote, blockquote, .sign') || !isVisibleAttachmentPreview(anchor)) return
        const href = anchor.getAttribute('href') || ''
        if (/^(?:ed2k:\/\/|magnet:\?)/i.test(href)) addText(href)
      })
    }

    // 用户已打开的 TXT/附件预览可能被插件挂在 body 下，不在首帖 DOM 内；
    // 只额外收集当前可见的预览区域，不扫描其他回复或隐藏预览
    getVisibleAttachmentPreviews().forEach((element) => {
      const owner = element.closest('[id^="post_"]')
      if (owner && owner !== root && !root?.contains(owner)) return
      if (!includeDetachedPreviews && !root?.contains(element)) return
      addText(getCleanLinkText(element))
      element.querySelectorAll('a[href]').forEach((anchor) => {
        const href = anchor.getAttribute('href') || ''
        if (/^(?:ed2k:\/\/|magnet:\?)/i.test(href)) addText(href)
      })
    })

    // 保留页面上首次出现的原始链接用于提交，但按资源哈希去重
    const unique = []
    const seen = new Set()
    for (const link of found) {
      const key = canonicalLinkKey(link)
      if (!key || seen.has(key)) continue
      seen.add(key)
      unique.push(link)
    }
    return unique
  }

  function collectScopeLinks(root, excludedRoots = []) {
    if (!root?.isConnected || excludedRoots.includes(root) ||
        root.closest(addonOwnUI + ', .quote, blockquote, .sign, ' + ignoredLinkContainer) ||
        !isVisibleAttachmentPreview(root)) return []
    const found = extractAttachmentLinks(getCleanLinkText(root, excludedRoots))
    const anchors = [...root.querySelectorAll('a[href]')]
    if (root.matches('a[href]')) anchors.unshift(root)
    for (const anchor of anchors) {
      if (anchor.closest(addonOwnUI + ', .quote, blockquote, .sign, ' + ignoredLinkContainer) ||
          excludedRoots.some((excluded) => excluded === anchor || excluded.contains(anchor)) ||
          !isVisibleAttachmentPreview(anchor)) continue
      const href = anchor.getAttribute('href') || ''
      if (/^(?:ed2k:\/\/|magnet:\?)/i.test(href)) found.push(href)
    }
    const seen = new Set()
    return found.filter((link) => {
      const key = canonicalLinkKey(link)
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  function getCodeContainers(root = document) {
    const candidates = [...root.querySelectorAll(codeContainerSelector)]
    if (root.matches?.(codeContainerSelector)) candidates.unshift(root)
    return candidates.filter((node) => !candidates.some((other) => other !== node && other.contains(node)))
  }

  function collectLoosePostLinks(root, previews = getVisibleAttachmentPreviews()) {
    const excluded = [...getCodeContainers(root), ...previews.filter((node) => root.contains(node))]
    return collectScopeLinks(root, excluded)
  }

  function getDownloadGroups() {
    const groups = []
    const codeRoots = getCodeContainers()
    const previews = getVisibleAttachmentPreviews()
    for (const source of codeRoots) {
      const readLinks = () => collectScopeLinks(source)
      if (readLinks().length) groups.push({ source, kind: 'block', readLinks })
    }
    for (const source of previews) {
      if (codeRoots.some((node) => node === source || node.contains(source))) continue
      const readLinks = () => collectScopeLinks(source, getCodeContainers(source))
      if (readLinks().length) groups.push({ source, kind: 'preview', readLinks })
    }
    const posts = getForumPostRoots()
    if (!posts.length && getMainPostRoot()) posts.push(getMainPostRoot())
    for (const source of posts) {
      const readLinks = () => source.isConnected ? collectLoosePostLinks(source) : []
      if (collectLoosePostLinks(source, previews).length) groups.push({ source, kind: 'post', readLinks })
    }
    return groups.sort((a, b) => a.source.compareDocumentPosition(b.source) & Node.DOCUMENT_POSITION_PRECEDING ? 1 : -1)
  }

  function getRawForumTopicTitle() {
    const selectors = [
      '#thread_subject', '.thread_subject', '#threadSubject',
      '.vwthd h1', '.thread-title', 'h1.thread-title',
      '.ts h1', '.ts', 'h1'
    ]
    let title = ''
    for (const selector of selectors) {
      const element = document.querySelector(selector)
      const value = (element?.innerText || element?.textContent || '').replace(/\s+/g, ' ').trim()
      if (value && value.length > 1) {
        title = value
        break
      }
    }
    if (!title) {
      title = document.querySelector('meta[property="og:title"]')?.content || document.title || ''
      title = title.replace(/\s*(?:-|｜|\|)\s*(?:色花堂|Powered by Discuz!?|Discuz!?).*$/i, '').trim()
    }
    return title
  }

  function getTopicKeywords() {
    return String(GM_getValue('topicBracketKeywords', defaultTopicKeywords) ?? '')
  }

  function findTopicBracketEnd(title, start) {
    const stack = []
    for (let index = start; index < title.length; index++) {
      const char = title[index]
      if (topicBracketPairs.has(char)) stack.push(topicBracketPairs.get(char))
      else if (topicBracketClosers.has(char)) {
        if (stack.pop() !== char) return -1
        if (!stack.length) return index + 1
      }
    }
    return -1
  }

  function formatForumTopicTitle(rawTitle, keywordText = getTopicKeywords()) {
    const keywords = [...new Set(String(keywordText).split(/\r?\n/)
      .map((word) => word.trim().toLowerCase()).filter(Boolean))]
    const title = String(rawTitle || '')
    // 先识别完整括号组，再找两端连续标签；保留未命中的组也不会中断检查。
    const parts = []
    let textStart = 0
    for (let index = 0; index < title.length;) {
      if (!topicBracketPairs.has(title[index])) { index++; continue }
      const end = findTopicBracketEnd(title, index)
      // 括号不完整时保留剩余原文，避免误删嵌套内容。
      if (end === -1) break
      if (index > textStart) parts.push({ text: title.slice(textStart, index), bracket: false })
      parts.push({ text: title.slice(index, end), bracket: true })
      index = end
      textStart = end
    }
    if (textStart < title.length) parts.push({ text: title.slice(textStart), bracket: false })
    const firstText = parts.findIndex((part) => !part.bracket && part.text.trim())
    let lastText = -1
    parts.forEach((part, index) => { if (!part.bracket && part.text.trim()) lastText = index })
    const extracted = parts.filter((part, index) => {
      const atEdge = firstText === -1 || index < firstText || index > lastText
      return !part.bracket || !atEdge || !keywords.some((word) => part.text.slice(1, -1).toLowerCase().includes(word))
    }).map((part) => part.text).join('')
    // 复制主题与文件夹创建共用名称规则：替换非法字符、整理空格、限制长度。
    const cleaned = extracted
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
      .replace(/\s+/g, ' ')
      .replace(/[. ]+$/g, '')
      .trim()
    return (cleaned || '论坛帖子').slice(0, 100)
  }

  function getForumTopicTitle() {
    return formatForumTopicTitle(getRawForumTopicTitle())
  }

  async function copyForumTopicTitle() {
    try {
      await GM_setClipboard(getForumTopicTitle(), 'text')
      customNotify('主题已复制')
    } catch (error) {
      customNotify('复制主题失败：' + (error?.message || error))
    }
  }

  function findCopyCodeElement(root = getMainPostRoot()) {
    const candidates = root?.matches('.blockcode') ? [root] : [...(root?.querySelectorAll('.blockcode') || [])]
    const blocks = candidates.filter((block) =>
      isVisibleAttachmentPreview(block) &&
      !block.closest('.quote, blockquote, .sign') &&
      !block.matches(addonOwnUI) && !block.closest(addonOwnUI) &&
      extractAttachmentLinks(block.innerText || block.textContent || '').length > 0
    )
    const findSmallCopy = (root) => {
      const candidates = [...root.querySelectorAll('a,button,span,em,strong,div,p')].filter((element) => {
        if (element.matches(addonOwnUI) || element.closest(addonOwnUI) || !isVisibleAttachmentPreview(element)) return false
        const label = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim()
        if (label !== '复制代码') return false
        return ![...element.children].some((child) =>
          (child.innerText || child.textContent || '').replace(/\s+/g, ' ').trim() === '复制代码'
        )
      })
      return candidates.find((element) => element.tagName === 'A' || element.tagName === 'BUTTON') ||
        candidates.find((element) => ['SPAN', 'EM', 'STRONG'].includes(element.tagName)) ||
        candidates[0] || null
    }
    for (const block of blocks) {
      const control = findSmallCopy(block)
      if (control) return control
    }
    for (const block of blocks) {
      for (const sibling of [block.previousElementSibling, block.nextElementSibling].filter((node) => node && root.contains(node))) {
        const label = (sibling.innerText || sibling.textContent || '').replace(/\s+/g, ' ').trim()
        if (label === '复制代码' && !sibling.closest(addonOwnUI)) return sibling
        const control = findSmallCopy(sibling)
        if (control) return control
      }
    }
    return null
  }

  function placeDownloadToolbar(toolbar, source, kind) {
    const copyCode = kind === 'block' ? findCopyCodeElement(source) : null
    const anchor = copyCode || source
    const inlineStyle = 'display:inline-flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0 0 0 10px;padding:0;border:0;background:transparent;vertical-align:middle;z-index:9999;max-width:calc(100vw - 40px);box-sizing:border-box;'
    const blockStyle = 'display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:10px 0;padding:8px 10px;border-left:3px solid #d42f2f;background:rgba(100,110,120,.1);border-radius:4px;max-width:calc(100vw - 40px);box-sizing:border-box;'
    const css = copyCode ? inlineStyle : blockStyle
    if (toolbar.style.cssText !== css) toolbar.style.cssText = css
    if (kind === 'post') {
      if (toolbar.parentElement !== source) source.appendChild(toolbar)
    } else if (anchor?.parentElement) {
      if (anchor.nextElementSibling !== toolbar) anchor.insertAdjacentElement('afterend', toolbar)
    }
  }

  async function handleWebBatchDownload(button, linkSource = null) {
    const toolbar = button.closest('.tm-115-download-actions')
    if (button.disabled || toolbar?.dataset.busy === 'true') return
    const readLinks = linkSource || collectPageLinks
    const links = readLinks()
    if (!links.length) {
      customNotify('当前帖子没有识别到可下载的 ED2K 或磁力链接')
      return
    }
    if (!config.webDownloadFolderId) {
      alert('请先点击右下角“115目录设置”，填写115网盘“云下载”目录的文件夹ID。')
      return
    }
    if (toolbar) toolbar.dataset.busy = 'true'
    const actionButtons = [...(toolbar?.querySelectorAll('button') || [button])]
    actionButtons.forEach((item) => { item.disabled = true })
    const originalText = button.textContent
    const outcomes = []
    let submittedCount = 0
    try {
      const topicTitle = getForumTopicTitle()
      // 多链接把主题作为 savepath，与父目录 ID 一起提交。
      // 不遍历历史任务，也不提前调用创建目录接口；重复与路径处理交给115。
      for (let index = 0; index < links.length; index++) {
        button.textContent = `正在提交 ${index + 1}/${links.length}…`
        try {
          if (links.length === 1) await addWebTorrents([links[index]])
          else await addWebTorrents([links[index]], config.webDownloadFolderId, topicTitle)
          submittedCount++
          outcomes.push(`成功 ${index + 1}/${links.length}`)
        } catch (error) {
          outcomes.push(`失败 ${index + 1}/${links.length}：${error?.message || error}`)
        }
      }
      customNotify([
        `提交完成：${submittedCount}/${links.length} 个链接成功`,
        links.length > 1 ? `保存子目录：${topicTitle}` : '单链接按原目录提交',
        ...outcomes
      ])
    } catch (error) {
      customNotify('添加链接失败：' + (error?.message || error))
    } finally {
      if (toolbar) delete toolbar.dataset.busy
      actionButtons.forEach((item) => { item.disabled = false })
      clearTimeout(linkScanTimer)
      linkScanTimer = setTimeout(findLinksAndCreateButtons, 180)
      button.textContent = readLinks().length ? `一键115下载（${readLinks().length}）` : originalText
    }
  }

  async function handleBotBatchDownload(button, linkSource = null) {
    const toolbar = button.closest('.tm-115-download-actions')
    if (button.disabled || toolbar?.dataset.busy === 'true') return
    const readLinks = linkSource || collectPageLinks
    const links = readLinks()
    if (!links.length) {
      customNotify('当前帖子没有识别到可下载的 ED2K 或磁力链接')
      return
    }
    if (toolbar) toolbar.dataset.busy = 'true'
    const actionButtons = [...(toolbar?.querySelectorAll('button') || [button])]
    actionButtons.forEach((item) => { item.disabled = true })
    const originalText = button.textContent
    try {
      button.textContent = `正在提交 ${links.length} 个链接…`
      const result = await addBotTorrents(links)
      customNotify(`已向 Bot 提交 ${links.length} 个链接。${result || ''}`)
    } catch (error) {
      customNotify('Bot 添加链接失败：' + (error?.message || error))
    } finally {
      if (toolbar) delete toolbar.dataset.busy
      actionButtons.forEach((item) => { item.disabled = false })
      clearTimeout(linkScanTimer)
      linkScanTimer = setTimeout(findLinksAndCreateButtons, 180)
      button.textContent = `Bot下载（${readLinks().length}）`
      if (!readLinks().length) button.textContent = originalText
    }
  }

  function findLinksAndCreateButtons() {
    initTxtAttachmentPreviews()
    initDownloadLocator()
    const groups = getDownloadGroups()
    const current = new Set(groups.map((group) => group.source))
    for (const [source, record] of downloadScopes) {
      if (!current.has(source)) { record.toolbar.remove(); downloadScopes.delete(source) }
    }
    if (groups.length && !document.getElementById('tm-115-settings')) createSettingButton()
    const main = getMainPostRoot()
    const primary = groups.find(({ source }) => main && (source === main || main.contains(source))) ||
      groups.find(({ source }) => !getForumPostRoots().some((post) => post.contains(source)))
    // 兼容已有标识，但这个 ID 现在只指向首个独立区域，不代表整页下载。
    for (const { toolbar } of downloadScopes.values()) toolbar.removeAttribute('id')
    for (const group of groups) {
      const { source, kind } = group
      let record = downloadScopes.get(source)
      if (!record) {
        const toolbar = document.createElement('div')
        toolbar.className = `tm-115-download-actions tm-115-post-actions tm-115-${kind}-actions`
        toolbar.dataset.postId = source.closest('[id^="post_"]')?.id || ''
        record = { toolbar, readLinks: group.readLinks }
        downloadScopes.set(source, record)
      }
      record.readLinks = group.readLinks
      if (group === primary) record.toolbar.id = 'tm-115-global-actions'
      placeDownloadToolbar(record.toolbar, source, kind)
      if (record.toolbar.dataset.busy !== 'true') {
        updateDownloadToolbarButtons(record.toolbar, record.readLinks(), () => record.readLinks())
      }
    }
    const settings = document.getElementById('tm-115-settings')
    if (settings) {
      const display = groups.length || hasOpenTxtAttachmentPreview() ? 'flex' : 'none'
      if (settings.style.getPropertyValue('display') !== display || settings.style.getPropertyPriority('display') !== 'important') {
        settings.style.setProperty('display', display, 'important')
      }
    }
  }

  function updateDownloadToolbarButtons(toolbar, links, linkSource = null) {
    const linkKey = JSON.stringify(links)
    const configKey = `${Boolean(config.webDownloadFolderId)}|${Boolean(config.botDownloadUrl)}`
    if (toolbar.dataset.linkKey === linkKey && toolbar.dataset.configKey === configKey) return
    toolbar.dataset.linkKey = linkKey
    toolbar.dataset.configKey = configKey
    toolbar.replaceChildren()

    const summary = document.createElement('span')
    summary.textContent = `已识别 ${links.length} 个不重复链接：`
    summary.style.cssText = 'font-size:13px;color:#555;margin-right:2px;'
    toolbar.appendChild(summary)

    const webButton = createStyledButton(`一键115下载（${links.length}）`)
    webButton.title = '仅下载当前代码框或区域中的链接。\n单个链接：直接下载到已设置的115目录。\n多个链接：按处理后的帖子主题创建子文件夹，并下载到其中。\n下载文件保留原名；单个或多个按当前区域内的链接数量判断。'
    webButton.classList.add('tm-115-global-web-download')
    webButton.addEventListener('click', () => handleWebBatchDownload(webButton, linkSource))
    toolbar.appendChild(webButton)

    const copyButton = createStyledButton('复制主题', '#1677ff', '#4096ff')
    copyButton.title = '复制按创建文件夹规则处理后的帖子主题'
    copyButton.classList.add('tm-115-copy-topic')
    copyButton.addEventListener('click', copyForumTopicTitle)
    toolbar.appendChild(copyButton)

    if (config.botDownloadUrl) {
      const botButton = createStyledButton(`Bot下载（${links.length}）`)
      botButton.classList.add('tm-115-global-bot-download')
      botButton.addEventListener('click', () => handleBotBatchDownload(botButton, linkSource))
      toolbar.appendChild(botButton)
    }
  }

  function startAttachmentObserver() {
    if (!document.body) return
    const observer = new MutationObserver((records) => {
      let shouldRescan = false
      for (const record of records) {
        const target = record.target?.nodeType === Node.ELEMENT_NODE ? record.target : record.target?.parentElement
        if (target?.closest(addonOwnUI)) continue
        if (record.type === 'attributes' || record.type === 'characterData') {
          shouldRescan = true
          break
        }
        const nodes = [...record.addedNodes, ...record.removedNodes]
        if (nodes.some((node) => {
          if (node.nodeType === Node.TEXT_NODE) return /(?:ed2k:|magnet:)/i.test(node.textContent || '')
          return node.nodeType === Node.ELEMENT_NODE && !node.matches(addonOwnUI) &&
            !node.closest(addonOwnUI) && !node.matches('script,style')
        })) {
          shouldRescan = true
          break
        }
      }
      if (shouldRescan) {
        clearTimeout(linkScanTimer)
        linkScanTimer = setTimeout(findLinksAndCreateButtons, 180)
      }
    })
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['style', 'class', 'hidden', 'open', 'aria-hidden', 'href', 'title', 'download'] })
  }

  function addBotTorrents(urls) {
    return new Promise((resolve, reject) => {
      try {
        //判断一下botDownloadUrl是否是以http或者https开头
        if (!/^(http|https):\/\/.+(\/)?$/i.test(config.botDownloadUrl)) {
          reject('115bot下载地址格式不正确')
          return
        }
        const url = (config.botDownloadUrl.endsWith('/') ? config.botDownloadUrl : config.botDownloadUrl + '/') + 'ghs/addTaskUrls'
        let formdata = new FormData()
        formdata.append('urls', JSON.stringify(urls))
        GM_xmlhttpRequest({
          method: 'POST',
          url: url,
          data: formdata,
          onload: (responseDetails) => {
            console.log(responseDetails)
            if (responseDetails.status === 200) {
              return responseDetails.responseText.includes('成功') ? resolve('添加' + responseDetails.responseText) : reject(responseDetails.responseText)
            }
            return reject('请检查bot下载地址是否正确')
          },
          onerror: () => {
            reject(' 请检查bot下载地址是否正确')
          },
        })
      } catch (err) {
        reject(' 请检查bot下载地址是否正确')
      }
    })
  }

  function addWebTorrents(urls, targetFolderId = config.webDownloadFolderId, savePath = '') {
    return new Promise((resolve, reject) => {
      const timeout = new Date().getTime()

      const fetchUserIDAndAddTorrents = () => {
        GM_xmlhttpRequest({
          method: 'GET',
          url: config.getUserUrl,
          onload: (responseDetails) => {
            let resData
            try {
              resData = JSON.parse(responseDetails.response)
            } catch (error) {
              reject('获取115用户信息失败: 无效的JSON数据')
              return
            }
            if (!resData.state) {
              reject('获取115用户信息失败')
              return
            }
            const userID = resData.data && resData.data[0] ? resData.data[0].user_id : null
            if (!userID) {
              reject('获取115用户信息失败: 用户ID未找到')
              return
            }
            GM_setValue('X_userID', userID)
            addTorrents(userID)
          },
          onerror: () => reject('获取用户信息失败'),
        })
      }

      const addTorrents = (userID) => {
        GM_xmlhttpRequest({
          method: 'GET',
          url: config.signUrl + timeout,
          onload: (responseDetails) => {
            if (responseDetails.responseText.indexOf('html') >= 0) {
              reject('还没有登录115')
              return
            }
            let signData
            try {
              signData = JSON.parse(responseDetails.response)
            } catch (error) {
              reject('获取签名失败: 无效的JSON数据')
              return
            }
            const { sign } = signData
            let falseUrl = urls.length === 1 ? true : false
            let encodedUrls = falseUrl ? `url=${encodeURIComponent(urls[0])}` : urls.map((url, index) => `url[${index}]=${encodeURIComponent(url)}`).join('&')
            const url = falseUrl ? config.addTaskUrl : config.addTaskUrls
            const addConfig = {
              method: 'POST',
              url: url,
              data: `${encodedUrls}&savepath=${encodeURIComponent(savePath)}&wp_path_id=${targetFolderId || config.webDownloadFolderId}&uid=${userID}&sign=${sign}&time=${timeout}`,
              headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
              onload: (res) => {
                let resData
                try {
                  resData = JSON.parse(res.response)
                } catch (error) {
                  reject('添加任务失败: 无效的JSON数据')
                  return
                }
                if (!falseUrl) {
                  if (resData.state === false) return reject(resData.error_msg || resData.error || resData.message || '添加任务失败')
                  const notifications = resData.result.map((item, index) => {
                    if (item.state === true) {
                      return `添加成功！索引：${index}`
                    } else {
                      return `添加失败：${item.error_msg || '未知错误'}`
                    }
                  })
                  resolve(notifications)
                } else {
                  if (resData.state === false) {
                    reject(resData.error_msg || resData.error || resData.message || '添加任务失败')
                  } else {
                    resolve('添加成功')
                  }
                }
              },
              onerror: () => reject('请求添加离线任务失败'),
            }
            GM_xmlhttpRequest(addConfig)
          },
          onerror: () => reject('获取签名失败'),
        })
      }

      let X_userID = GM_getValue('X_userID', '')
      if (!X_userID) {
        fetchUserIDAndAddTorrents()
      } else {
        addTorrents(X_userID)
      }
    })
  }

  function customNotify(message) {
    // 使用独立的油猴提示层，不复用论坛的 #ntcwin/.popupcredit，
    // 避免论坛自带橙色背景、字体和宽度样式与脚本提示叠加。
    const oldForumToast = document.getElementById('ntcwin')
    if (oldForumToast) oldForumToast.style.display = 'none'

    let toast = document.getElementById('tm-115-toast')
    if (!toast) {
      toast = document.createElement('div')
      toast.id = 'tm-115-toast'
      toast.setAttribute('role', 'status')
      toast.style.cssText = [
        'position:fixed!important',
        'top:24px!important',
        'left:50%!important',
        'transform:translateX(-50%)!important',
        'z-index:2147483647!important',
        'display:none',
        'box-sizing:border-box!important',
        'width:max-content',
        'max-width: min(440px, calc(100vw - 32px))!important',
        'padding:14px 18px!important',
        'border:1px solid transparent!important',
        'border-radius:10px!important',
        'box-shadow:0 6px 24px rgba(0,0,0,.32)!important',
        'font-family:Arial,"Microsoft YaHei",sans-serif!important',
        'font-size:16px!important',
        'font-weight:500!important',
        'line-height:1.5!important',
        'text-align:left!important',
        'white-space:normal!important',
        'overflow-wrap:anywhere!important',
        'word-break:break-word!important',
        'color:#5c4700!important',
        'background:#fff1a8!important',
        'background-image:none!important'
      ].join(';')
      document.body.appendChild(toast)
    }

    const messages = (Array.isArray(message) ? message : [String(message ?? '')])
      .map((line) => String(line ?? '').trim())
      .filter(Boolean)
    const text = messages.join('\n')
    const isError = /失败|错误|异常|error|failed|拒绝/i.test(text)

    toast.replaceChildren()
    messages.forEach((line, index) => {
      const row = document.createElement('div')
      row.textContent = line
      row.style.cssText = [
        'display:block!important',
        'margin:0!important',
        'padding:0!important',
        'font-family:Arial,"Microsoft YaHei",sans-serif!important',
        'font-size:16px!important',
        'font-weight:500!important',
        'line-height:1.5!important',
        'white-space:normal!important',
        'overflow-wrap:anywhere!important',
        'word-break:break-word!important',
        index ? 'margin-top:3px!important' : ''
      ].join(';')
      toast.appendChild(row)
    })

    toast.style.setProperty('background', isError ? '#c62828' : '#fff1a8', 'important')
    toast.style.setProperty('border-color', isError ? '#a51f1f' : '#e0b83f', 'important')
    toast.style.setProperty('color', isError ? '#ffffff' : '#5c4700', 'important')
    toast.style.setProperty('display', 'block', 'important')

    if (toast.__hideTimer) clearTimeout(toast.__hideTimer)
    toast.__hideTimer = setTimeout(() => {
      toast.style.setProperty('display', 'none', 'important')
    }, 4000)
  }

  function handleLinks(links, addUrlFunction) {
    addUrlFunction(links)
      .then((res) => {
        customNotify(res)
      })
      .catch((error) => {
        customNotify('添加链接失败: ' + error)
      })
  }

  function createStyledButton(text, backgroundColor = '#d42f2f', hoverColor = '#db2a3a') {
    const button = document.createElement('button')
    button.textContent = text
    button.style.padding = '10px'
    button.style.border = 'none'
    button.style.borderRadius = '5px'
    button.style.backgroundColor = backgroundColor
    button.style.color = 'white'
    button.style.marginRight = '10px'
    button.style.cursor = 'pointer'
    button.style.fontSize = '16px'
    button.onmouseover = function () {
      this.style.backgroundColor = hoverColor
    }
    button.onmouseout = function () {
      this.style.backgroundColor = backgroundColor
    }
    return button
  }

  function createButton(text, onClick) {
    const button = document.createElement('em')
    button.textContent = text
    button.style.cssText = 'cursor: pointer; margin-left: 10px;'
    button.addEventListener('click', onClick)
    return button
  }

  function createSettingButton() {
    if (document.getElementById('tm-115-settings')) return
    const buttonContainer = document.createElement('div')
    buttonContainer.id = 'tm-115-settings'
    buttonContainer.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:1000;display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px;max-width:calc(100vw - 32px);box-sizing:border-box;'
    document.body.appendChild(buttonContainer)
    ;['主题规则', '115目录设置'].forEach((type) => {
      const button = type === '主题规则' ? createStyledButton(type, '#1677ff', '#4096ff') : createStyledButton(type)
      // 长宽各缩至约57.7%，使按钮占用面积约为原来的三分之一。
      button.style.zoom = String(Math.sqrt(1 / 3))
      button.addEventListener('click', () => handleSetting(type))
      buttonContainer.appendChild(button)
    })
  }

  function handleSetting(type) {
    if (type === '主题规则') { showTopicRuleSettings(); return }
    if (type !== '115目录设置') return
    const promptText = '请输入115网盘“云下载”目录的文件夹ID（多链接时会在其下创建帖子文件夹）:'
    const settingKey = 'webDownloadFolderId'
    const inputValue = prompt(promptText, config[settingKey])
    if (inputValue !== null) {
      GM_setValue(settingKey, inputValue)
      setTimeout(() => window.location.reload(), 2000)
    }
  }

  function showTopicRuleSettings() {
    if (document.getElementById('tm-115-title-settings')) return
    const overlay = document.createElement('div')
    overlay.id = 'tm-115-title-settings'
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;'
    const panel = document.createElement('div')
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-modal', 'true')
    panel.setAttribute('aria-labelledby', 'tm-115-title-settings-heading')
    panel.style.cssText = 'width:560px;max-width:100%;max-height:90vh;overflow:auto;box-sizing:border-box;background:#fff;color:#222;padding:22px;border-radius:10px;font:15px/1.6 Arial,"Microsoft YaHei",sans-serif;box-shadow:0 8px 32px rgba(0,0,0,.3);'
    overlay.appendChild(panel)
    const heading = document.createElement('h2')
    heading.id = 'tm-115-title-settings-heading'
    heading.textContent = '主题提取规则'
    heading.style.cssText = 'font-size:20px;margin:0 0 12px;color:#222;'
    panel.appendChild(heading)
    const description = document.createElement('p')
    description.textContent = '只检查标题两端连续的括号标签，包含任意关键词才删除整段；中间标签保留。支持常见中英文括号，不区分英文大小写。'
    description.style.cssText = 'margin:0 0 12px;color:#555;'
    panel.appendChild(description)
    const addField = (labelText, id, rows, value, readOnly = false) => {
      const label = document.createElement('label')
      label.htmlFor = id
      label.textContent = labelText
      label.style.cssText = 'display:block;margin:12px 0 4px;color:#222;'
      const field = document.createElement('textarea')
      field.id = id
      field.rows = rows
      field.value = value
      field.readOnly = readOnly
      field.style.cssText = 'display:block;box-sizing:border-box;width:100%;padding:8px;border:1px solid #bbb;border-radius:5px;background:#fff;color:#222;font:14px/1.5 Arial,"Microsoft YaHei",sans-serif;resize:vertical;'
      panel.append(label, field)
      return field
    }
    const keywords = addField('删除关键词（每行一个；留空则不删除标签）', 'tm-115-topic-keywords', 5, getTopicKeywords())
    const sample = addField('原始标题（可以修改，测试其他标题）', 'tm-115-topic-sample', 3, getRawForumTopicTitle())
    const preview = addField('处理结果（与复制主题、创建文件夹一致）', 'tm-115-topic-preview', 3, '', true)
    const updatePreview = () => { preview.value = formatForumTopicTitle(sample.value, keywords.value) }
    keywords.addEventListener('input', updatePreview)
    sample.addEventListener('input', updatePreview)
    updatePreview()
    const actions = document.createElement('div')
    actions.style.cssText = 'margin-top:16px;display:flex;flex-wrap:wrap;gap:8px;'
    const save = createStyledButton('保存', '#1677ff', '#4096ff')
    const reset = createStyledButton('恢复默认', '#666', '#888')
    const cancel = createStyledButton('取消', '#666', '#888')
    const previousFocus = document.activeElement
    const close = () => { overlay.remove(); previousFocus?.focus() }
    save.addEventListener('click', () => {
      try {
        const normalized = [...new Set(keywords.value.split(/\r?\n/).map((word) => word.trim()).filter(Boolean))].join('\n')
        GM_setValue('topicBracketKeywords', normalized)
        close()
        customNotify('主题规则已保存，复制主题和创建文件夹立即生效')
      } catch (error) { customNotify('保存主题规则失败：' + (error?.message || error)) }
    })
    reset.addEventListener('click', () => { keywords.value = defaultTopicKeywords; updatePreview() })
    cancel.addEventListener('click', close)
    overlay.addEventListener('click', (event) => { if (event.target === overlay) close() })
    panel.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); close() }
      if (event.key === 'Tab') {
        const controls = [...panel.querySelectorAll('textarea, button')]
        const target = event.shiftKey ? controls.at(-1) : controls[0]
        if ((event.shiftKey && document.activeElement === controls[0]) || (!event.shiftKey && document.activeElement === controls.at(-1))) {
          event.preventDefault(); target.focus()
        }
      }
    })
    actions.append(save, reset, cancel)
    panel.appendChild(actions)
    document.body.appendChild(overlay)
    keywords.focus()
  }

  function showCookie() {
    // 使用GM_cookie函数获取Cookie
    GM_cookie.list({ domain: '.115.com' }, function (cookieInfos, error) {
      if (!error) {
        let cookieOutputs = []
        cookieInfos.forEach(function (cookieInfo) {
          if (requireCookieNames.includes(cookieInfo.name)) {
            cookieOutputs.push(`${cookieInfo.name}=${cookieInfo.value}`)
          }
        })
        alert(`Cookie信息为：\n---------------------------\n${cookieOutputs.join('\n')}\n---------------------------\n内容已复制到剪切板！`)
        GM_setClipboard(`${cookieOutputs.join(';')};`)
      } else {
        alert('获取cookie失败，请检查是否支持GM_cookie函数（目前只有beta版支持）')
      }
    })
  }

  function initCopyCookieButton() {
    let btnGroupDiv = document.querySelector('div.left-tvf[rel="left_tvf"]')
    if (btnGroupDiv) {
      // 创建复制 Cookie 按钮
      let copyButton = document.createElement('a')
      copyButton.href = 'javascript:;'
      copyButton.className = 'button btn-line btn-upload'
      copyButton.innerHTML = '<i class="icon-operate ifo-copy"></i><span>复制Cookie</span>'

      // 点击显示Cookie
      copyButton.addEventListener('click', showCookie)

      btnGroupDiv.appendChild(copyButton)
    }
  }

  function getRequireFieldFromCookie(requireFields, cookie) {
    let resMap = new Map()
    if (!cookie) {
      return resMap
    }
    let cookies = cookie.split(';')
    cookies.forEach(function (cookie) {
      if (!cookie) {
        return
      }
      let kv = cookie.split('=')
      if (kv.length != 2) {
        return
      }
      if (requireFields.includes(kv[0])) {
        resMap.set(kv[0], kv[1])
      }
    })
    return resMap
  }

  function handleCookieLogin(requireCookieMap, validDuration) {
    requireCookieMap.forEach((value, key) => {
      GM_cookie.delete({ name: key }, function (error) {
        if (error) {
          alert(`清除Cookie：[${key}]失败！请检查是否支持GM_cookie函数（目前只有beta版支持）`)
        }
      })
      GM_cookie.set(
        {
          // url: '.115.com',
          name: key,
          value: value,
          domain: '.115.com',
          path: '/',
          secure: false,
          httpOnly: false,
          expirationDate: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * validDuration, // Expires in 30 days
        },
        function (error) {
          if (error) {
            alert(`设置Cookie：[${key}]失败，值为：[${value}]！请检查是否支持GM_cookie函数（目前只有beta版支持）`)
          }
        }
      )
    })
    setTimeout(function () {
      location.reload()
    }, 1000)
  }

  function showCookieLoginInputDialog() {
    let inputCookie = prompt('请输入 Cookie：')
    let requireCookieMap = getRequireFieldFromCookie(requireCookieNames, inputCookie)
    if (requireCookieMap.size != requireCookieNames.length) {
      alert(`输入的Cookie需包含[${requireCookieNames.join(',')}]，请重新输入！`)
      return
    }
    let defaultValidDuration = 30
    let inputValidDuration = prompt('请输入Cookie有效天数：', defaultValidDuration)
    let validDuration = parseInt(inputValidDuration, 10) || defaultValidDuration
    handleCookieLogin(requireCookieMap, validDuration)
  }

  function initCookieLoginButton() {
    let loginFooter = document.querySelector('div.login-footer[rel="login_footer"]')
    if (loginFooter) {
      // 分隔符
      let splitField = document.createElement('i')
      splitField.textContent = '|'
      // 登录按钮
      let loginSpan = document.createElement('span')
      let loginButton = document.createElement('a')
      loginButton.textContent = '使用 Cookie 登录'
      loginButton.href = 'javascript:;'
      loginButton.addEventListener('click', showCookieLoginInputDialog)
      loginSpan.appendChild(loginButton)
      loginFooter.insertBefore(splitField, loginFooter.firstElementChild)
      loginFooter.insertBefore(loginButton, loginFooter.firstElementChild)
    }
  }

  // 115 的 push_extract POST 只表示已受理；必须 GET 到最终状态 4 才能判定密码通过。
  function normalizeUnzipPasswords(value) {
    const items = Array.isArray(value) ? value : String(value ?? '').split(/\r\n|\n|\r/)
    return [...new Set(items.filter((item) => typeof item === 'string' && item.length > 0))]
  }

  function init115PasswordPool() {
    if (!/(^|\.)115\.com$/i.test(location.hostname)) return
    const storageKey = 'unzipPasswordPoolV1'
    const pageWindow = typeof unsafeWindow === 'undefined' ? window : unsafeWindow
    let active = null
    const records = new Set()
    const readPool = () => normalizeUnzipPasswords(GM_getValue(storageKey, []))
    const style = document.createElement('style')
    style.textContent = `
      .tm115-unzip-box{height:auto!important;max-height:calc(100vh - 32px);overflow:auto}
      .tm115-password-tools{font:13px/1.6 Arial,sans-serif;margin:12px auto;text-align:center;max-width:440px;color:#9ca9b8}
      .tm115-password-tools button,#tm115-password-manager button{font:13px/1.5 Arial,sans-serif;cursor:pointer;color:#dce8f4;background:#263547;border:1px solid #45617c;border-radius:5px;padding:5px 10px;margin:3px}
      .tm115-password-tools button:disabled,#tm115-password-manager button:disabled{opacity:.45;cursor:default}
      .tm115-password-status{white-space:normal;overflow-wrap:anywhere;margin-top:5px}
      #tm115-password-manager{position:fixed;inset:0;background:#0009;z-index:2147483646;display:flex;align-items:center;justify-content:center;color:#dce8f4;font:14px/1.6 Arial,sans-serif}
      #tm115-password-manager section{box-sizing:border-box;background:#19212b;border:1px solid #45617c;border-radius:10px;padding:20px;width:620px;max-width:95vw;max-height:88vh;overflow:auto;box-shadow:0 12px 45px #0008}
      #tm115-password-manager h2{font-size:19px;margin:0 0 8px;color:inherit}
      #tm115-password-manager p{margin:8px 0;color:#aebdce}
      #tm115-password-manager .tm115-password-row{display:flex;align-items:center;gap:4px;margin:5px 0}
      #tm115-password-manager .tm115-password-row input{flex:1;min-width:60px}
      #tm115-password-manager input,#tm115-password-manager textarea{box-sizing:border-box;background:#111820;color:#e3edf7;border:1px solid #45617c;border-radius:4px;padding:7px;font:14px/1.5 monospace}
      #tm115-password-manager textarea{display:block;width:100%;height:92px;resize:vertical}
      #tm115-password-manager .tm115-password-manager-status{color:#f1cd80;min-height:22px}
    `
    document.head.appendChild(style)

    function setStatus(record, text) { record.status.textContent = text }
    function isCurrent(run) {
      return active === run && !run.stopped && run.record.root.isConnected &&
        run.record.root.getClientRects().length > 0 &&
        run.record.root.querySelector('.title')?.textContent === run.fileName
    }
    function stop(record, message = '已停止；不会再尝试下一个密码') {
      if (active?.record !== record) return
      const run = active
      run.stopped = true
      active = null
      run.cancelWait?.()
      run.cancelRequest?.()
      record.start.disabled = false
      record.stop.hidden = true
      setStatus(record, message)
    }
    function check(run) {
      if (!isCurrent(run)) throw new Error('测试已停止')
    }
    function wait(run, milliseconds) {
      check(run)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { run.cancelWait = null; resolve() }, milliseconds)
        run.cancelWait = () => { clearTimeout(timer); run.cancelWait = null; reject(new Error('测试已停止')) }
      })
    }
    function request(run, method, data) {
      check(run)
      return new Promise((resolve, reject) => {
        let done = false
        let handle
        const finish = (error, response) => {
          if (done) return
          done = true
          run.cancelRequest = null
          if (error) reject(error)
          else resolve(response)
        }
        run.cancelRequest = () => { finish(new Error('测试已停止')); handle?.abort?.() }
        const params = new URLSearchParams(data).toString()
        try {
          handle = GM_xmlhttpRequest({
            method, url: 'https://webapi.115.com/files/push_extract' + (method === 'GET' ? '?' + params : ''),
            ...(method === 'POST' ? { headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }, data: params } : {}),
            timeout: 20000,
            onload(response) {
              if (response.status !== 200) return finish(new Error('请求失败（HTTP ' + response.status + '），已暂停'))
              try { finish(null, JSON.parse(response.responseText)) }
              catch (_) { finish(new Error('无法识别服务器响应，已暂停')) }
            },
            onerror: () => finish(new Error('网络异常，已暂停')),
            ontimeout: () => finish(new Error('请求超时，已暂停')),
            onabort: () => finish(new Error('请求已取消')),
          })
        } catch (_) { finish(new Error('无法发起密码测试请求')) }
      })
    }
    // 临时接住原生确认动作，读取当前压缩包及其成功回调，不额外提交一次解压。
    function captureSubmission(record) {
      const jq = pageWindow.jQuery
      if (typeof jq?.ajax !== 'function') throw new Error('未找到115页面接口，请刷新页面后重试')
      const original = jq.ajax
      let submission
      const intercept = function (options) {
        const url = new URL(options?.url || '', location.href)
        if (url.hostname !== 'webapi.115.com' || url.pathname !== '/files/push_extract' ||
            String(options.type).toLowerCase() !== 'post' || !options.data?.pick_code ||
            options.data.secret !== record.input.value) throw new Error('115页面接口已变化，已停止测试')
        submission = { pickCode: String(options.data.pick_code), success: options.success, context: options.context || options }
        return undefined
      }
      try {
        jq.ajax = intercept
        if (jq.ajax !== intercept) throw new Error('无法连接115页面接口')
        record.synthetic = true
        record.confirm.click()
      } finally {
        record.synthetic = false
        jq.ajax = original
        jq.closeTip?.()
      }
      if (!submission || typeof submission.success !== 'function') throw new Error('无法识别115确认动作，未开始测试')
      return submission
    }
    async function testPassword(run, password, index) {
      check(run)
      const record = run.record
      record.input.value = password
      record.input.dispatchEvent(new Event('input', { bubbles: true }))
      const submission = captureSubmission(record)
      if (run.pickCode && run.pickCode !== submission.pickCode) throw new Error('压缩包已切换，已停止')
      run.pickCode = submission.pickCode
      const initial = await request(run, 'POST', { pick_code: run.pickCode, secret: password })
      check(run)
      if (initial.state !== true) {
        if (/密码.{0,8}(错误|不正确)/.test(String(initial.message || ''))) return false
        throw new Error(String(initial.message || '服务器未受理测试，已暂停'))
      }
      const deadline = Date.now() + 120000
      while (Date.now() < deadline) {
        await wait(run, 1000)
        const result = await request(run, 'GET', { pick_code: run.pickCode })
        check(run)
        if (result.state !== true) throw new Error(String(result.message || '查询解压状态失败，已暂停'))
        const status = Number(result.data?.extract_status?.unzip_status)
        if (status === 6) return false
        if (status === 4) {
          setStatus(record, `第 ${index + 1} / ${run.passwords.length} 个密码通过，正在打开压缩包`)
          run.completed = true
          // 调用原来的成功回调，让115显示文件列表；不自动选择目标目录或落盘。
          submission.success.call(submission.context, initial)
          customNotify(`云解压密码通过：${password}（第 ${index + 1} 个）`)
          return true
        }
        if (status !== 0 && status !== 1) throw new Error('云解压异常（状态 ' + status + '），已暂停')
        const progress = result.data.extract_status.progress
        setStatus(record, `正在测试第 ${index + 1} / ${run.passwords.length} 个密码` +
          (progress != null ? `，等待115校验（${progress}%）` : '，等待115校验…'))
      }
      throw new Error('等待校验超过2分钟，已暂停；未跳过当前密码')
    }
    async function start(record) {
      if (active) return
      const passwords = readPool()
      if (!passwords.length) { openManager(record); return }
      const run = { record, passwords, fileName: record.root.querySelector('.title')?.textContent, stopped: false }
      active = run
      record.start.disabled = true
      record.stop.hidden = false
      try {
        for (let index = 0; index < passwords.length; index++) {
          check(run)
          setStatus(record, `正在测试第 ${index + 1} / ${passwords.length} 个密码…`)
          if (await testPassword(run, passwords[index], index)) return
          check(run)
          setStatus(record, `第 ${index + 1} 个密码错误`)
          if (index < passwords.length - 1) await wait(run, 1000)
        }
        setStatus(record, `已尝试全部 ${passwords.length} 个密码，均不正确；可修改密码池后重新测试`)
      } catch (error) {
        if (active === run) setStatus(record, error?.message || '测试异常，已暂停')
      } finally {
        if (active === run) {
          active = null
          record.start.disabled = false
          record.stop.hidden = true
        }
      }
    }
    function button(text, action) {
      const node = document.createElement('button')
      node.type = 'button'
      node.textContent = text
      node.addEventListener('click', action)
      return node
    }
    function openManager(record) {
      if (document.getElementById('tm115-password-manager')) return
      stop(record, '已停止测试，可以调整密码池')
      let draft = readPool()
      const overlay = document.createElement('div')
      overlay.id = 'tm115-password-manager'
      const panel = document.createElement('section')
      panel.setAttribute('role', 'dialog')
      panel.setAttribute('aria-modal', 'true')
      panel.setAttribute('aria-labelledby', 'tm115-password-heading')
      const heading = document.createElement('h2')
      heading.id = 'tm115-password-heading'
      heading.textContent = '云解压密码池'
      const hint = document.createElement('p')
      hint.textContent = '按从上到下的顺序测试；可拖拽，或用↑↓和置顶调整。密码只保存在当前浏览器的脚本存储中。'
      const list = document.createElement('div')
      const message = document.createElement('p')
      message.className = 'tm115-password-manager-status'
      message.setAttribute('role', 'status')
      const bulk = document.createElement('textarea')
      bulk.placeholder = '批量添加密码，每行一个；大小写、空格和符号原样保留'
      bulk.setAttribute('aria-label', '批量添加密码')
      let dragIndex = null
      const move = (from, to) => {
        if (to < 0 || to >= draft.length || from === to) return
        draft.splice(to, 0, draft.splice(from, 1)[0]); render()
      }
      function render() {
        list.replaceChildren()
        draft.forEach((password, index) => {
          const row = document.createElement('div')
          row.className = 'tm115-password-row'
          const grip = document.createElement('span')
          grip.textContent = '☰ ' + (index + 1)
          grip.draggable = true
          grip.title = '拖动调整顺序'
          grip.style.cursor = 'grab'
          grip.addEventListener('dragstart', (event) => { dragIndex = index; event.dataTransfer.setData('text/plain', String(index)) })
          grip.addEventListener('dragend', () => { dragIndex = null })
          row.addEventListener('dragover', (event) => { if (dragIndex !== null) event.preventDefault() })
          row.addEventListener('drop', (event) => { event.preventDefault(); if (dragIndex !== null) move(dragIndex, index); dragIndex = null })
          const input = document.createElement('input')
          input.type = 'text'
          input.autocomplete = 'off'
          input.spellcheck = false
          input.value = password
          input.setAttribute('aria-label', '第' + (index + 1) + '个密码')
          input.addEventListener('input', () => { draft[index] = input.value })
          const up = button('↑', () => move(index, index - 1)); up.disabled = index === 0
          const down = button('↓', () => move(index, index + 1)); down.disabled = index === draft.length - 1
          row.append(grip, input, up, down, button('置顶', () => move(index, 0)), button('删除', () => { draft.splice(index, 1); render() }))
          list.appendChild(row)
        })
      }
      const close = () => { overlay.remove(); record.manage.focus() }
      const add = button('添加到列表', () => {
        const combined = draft.concat(String(bulk.value).split(/\r\n|\n|\r/))
        const normalized = normalizeUnzipPasswords(combined)
        const removed = combined.filter((item) => item.length > 0).length - normalized.length
        draft = normalized; bulk.value = ''; render()
        message.textContent = `当前 ${draft.length} 个密码` + (removed ? `，已去除 ${removed} 个重复项` : '')
      })
      const save = button('保存', () => {
        if (bulk.value.length) { message.textContent = '批量输入区还有内容，请先点击“添加到列表”'; return }
        const normalized = normalizeUnzipPasswords(draft)
        try { GM_setValue(storageKey, normalized) }
        catch (_) { message.textContent = '保存失败，请重试'; return }
        close()
        setStatus(record, `密码池已保存，共 ${normalized.length} 个密码；下次按新顺序测试`)
      })
      panel.append(heading, hint, list, bulk, add, message, save, button('取消', close))
      overlay.appendChild(panel)
      document.body.appendChild(overlay)
      panel.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
        if (event.key === 'Tab') {
          const controls = [...panel.querySelectorAll('input,textarea,button:not(:disabled)')]
          const first = controls[0], last = controls.at(-1)
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
        }
      })
      render()
      bulk.focus()
    }
    function scan() {
      if (!document?.body) return
      for (const record of records) {
        if (!record.root.isConnected || !record.root.getClientRects().length) {
          if (!active?.completed) stop(record, '弹窗已关闭，测试已停止')
          if (!record.root.isConnected) records.delete(record)
        } else if (active?.record === record && !isCurrent(active)) stop(record, '压缩包已切换，测试已停止')
      }
      for (const root of document.querySelectorAll('.unzip-dialog')) {
        if (root.querySelector('.tm115-password-tools')) continue
        const input = root.querySelector('input[type="password"]'), confirm = root.querySelector('[btn="confirm"]')
        if (!input || !confirm) continue
        const tools = document.createElement('div')
        tools.className = 'tm115-password-tools'
        const status = document.createElement('div')
        status.className = 'tm115-password-status'
        status.setAttribute('role', 'status')
        const record = { root, input, confirm, tools, status, synthetic: false }
        record.start = button('自动测试密码', () => start(record))
        record.stop = button('停止', () => stop(record)); record.stop.hidden = true
        record.manage = button('密码池管理', () => openManager(record))
        tools.append(record.start, record.stop, record.manage, status)
        root.querySelector('.action')?.before(tools)
        if (!tools.isConnected) root.appendChild(tools)
        root.closest('.dialog-box')?.classList.add('tm115-unzip-box')
        setStatus(record, `密码池共 ${readPool().length} 个密码，按列表顺序测试`)
        input.addEventListener('input', (event) => { if (event.isTrusted) stop(record, '已手动修改密码，测试已停止') })
        root.closest('.dialog-box')?.addEventListener('click', (event) => {
          const target = event.target.closest('[btn], .close')
          if (!target || record.synthetic) return
          if (target === confirm && active?.record === record) {
            event.preventDefault(); event.stopImmediatePropagation()
            setStatus(record, '正在自动测试，请先停止后再手动确定')
          } else if (target.matches('[btn="cancel"], [btn="close"], .close, [btn="clear"]')) stop(record)
        }, true)
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' && active?.record === record) { event.preventDefault(); event.stopImmediatePropagation() }
        }, true)
        input.addEventListener('keyup', (event) => {
          if (event.key === 'Enter' && active?.record === record) { event.preventDefault(); event.stopImmediatePropagation() }
        }, true)
        records.add(record)
      }
    }
    let scheduled = false
    new MutationObserver(() => {
      if (scheduled) return
      scheduled = true
      queueMicrotask(() => { scheduled = false; scan() })
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] })
    window.addEventListener('pagehide', () => { if (active) stop(active.record) })
    scan()
  }

  if (/(^|\.)115\.com$/i.test(location.hostname)) {
    init115PasswordPool()
  } else {
    findLinksAndCreateButtons()
    startTxtPreviewPositioning()
    startAttachmentObserver()
  }
  initCookieLoginButton()
  initCopyCookieButton()
})()
