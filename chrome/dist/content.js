"use strict";
// ── API helpers ──────────────────────────────────────────────────────────────
async function getDid(handle) {
    const response = await fetch(`https://bsky.social/xrpc/com.atproto.identity.resolveHandle?handle=${handle}`);
    if (!response.ok)
        throw new Error("Could not resolve handle");
    const { did } = await response.json();
    return did;
}
function getCdnUrl(did, blobRef, format) {
    return `https://cdn.bsky.app/img/${format}/plain/${did}/${blobRef.ref.$link}@${blobRef.mimeType.split('/')[1] || 'jpeg'}`;
}
function getVideoPlaylistUrl(did, cid) {
    return `https://video.bsky.app/watch/${encodeURIComponent(did)}/${cid}/playlist.m3u8`;
}
function getVideoThumbnailUrl(did, cid) {
    return `https://video.bsky.app/watch/${encodeURIComponent(did)}/${cid}/thumbnail.jpg`;
}
// Dynamically load hls.js from CDN (only loaded once, on first use)
let hlsPromise = null;
function loadHlsJs() {
    if (hlsPromise)
        return hlsPromise;
    hlsPromise = new Promise((resolve, reject) => {
        // If already loaded by the page, use that
        if (window.Hls) {
            resolve(window.Hls);
            return;
        }
        const script = document.createElement("script");
        script.src = "https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js";
        script.onload = () => resolve(window.Hls);
        script.onerror = () => reject(new Error("Failed to load hls.js"));
        document.head.appendChild(script);
    });
    return hlsPromise;
}
async function getPostContent(uri) {
    try {
        const [repo, collection, rkey] = uri.split("/").slice(-3);
        const response = await fetch(`https://bsky.social/xrpc/com.atproto.repo.getRecord?repo=${repo}&collection=${collection}&rkey=${rkey}`);
        if (!response.ok)
            return null;
        const data = await response.json();
        return data.value;
    }
    catch {
        return null;
    }
}
// Batch-fetch profiles to get handles AND avatar URLs for multiple DIDs
async function getProfiles(dids) {
    const profiles = new Map();
    const uniqueDids = [...new Set(dids)];
    if (uniqueDids.length === 0)
        return profiles;
    // Batch in groups of 25 (API max)
    for (let i = 0; i < uniqueDids.length; i += 25) {
        const batch = uniqueDids.slice(i, i + 25);
        try {
            const params = batch.map((d) => `actors=${encodeURIComponent(d)}`).join("&");
            const response = await fetch(`https://public.api.bsky.app/xrpc/app.bsky.actor.getProfiles?${params}`);
            if (!response.ok)
                continue;
            const data = await response.json();
            for (const p of data.profiles || []) {
                let avatarUrl;
                if (p.avatar) {
                    // Public API returns avatar as a full CDN URL string;
                    // PDS API returns it as a blob ref object with ref.$link
                    if (typeof p.avatar === 'string') {
                        avatarUrl = p.avatar;
                    }
                    else if (p.avatar.ref?.$link) {
                        avatarUrl = `https://cdn.bsky.app/img/avatar/plain/${p.did}/${p.avatar.ref.$link}@jpeg`;
                    }
                }
                profiles.set(p.did, {
                    did: p.did,
                    handle: p.handle,
                    avatarUrl,
                    displayName: p.displayName,
                });
            }
        }
        catch {
            // skip failed batches
        }
    }
    return profiles;
}
// ── Likes feed (tab content) ────────────────────────────────────────────────
let activeLikesContainer = null;
function getLikesContainerParent() {
    const tablist = document.querySelector('[data-testid="profilePager"]');
    if (!tablist)
        return null;
    // The container that holds profile header, tabs, AND content items
    return tablist.parentElement?.parentElement;
}
async function fetchAndRenderLikes(handle) {
    const container = getLikesContainerParent();
    if (!container)
        return;
    // Remove any existing likes container
    removeLikesContainer();
    // Create likes container
    const likesContainer = document.createElement("div");
    likesContainer.id = "bsky-likes-feed";
    likesContainer.style.cssText = "width: 100%; margin-left: auto; margin-right: auto; max-width: 600px; border-top: 1px solid rgb(46,55,67);";
    likesContainer.className = "css-g5y9jx";
    // Loading indicator
    likesContainer.innerHTML = `
    <div style="text-align:center; padding:40px 20px; color:rgb(171,184,201); font-size:15px; font-family:InterVariable,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
      <div style="display:inline-block; width:24px; height:24px; border:2px solid rgb(60,65,73); border-top-color:rgb(15,115,255); border-radius:50%; animation:bsky-likes-spin 0.6s linear infinite; margin-bottom:8px;"></div>
      <div>Loading likes…</div>
    </div>
    <style>
      @keyframes bsky-likes-spin { to { transform: rotate(360deg); } }
    </style>
  `;
    // Insert after the tab bar (index 2)
    const tabBar = container.children[2];
    tabBar.after(likesContainer);
    activeLikesContainer = likesContainer;
    // Scroll the likes container into view
    likesContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
    try {
        const did = await getDid(handle);
        const response = await fetch(`https://bsky.social/xrpc/com.atproto.repo.listRecords?repo=${did}&collection=app.bsky.feed.like&limit=50`);
        if (!response.ok)
            throw new Error(`Server responded with ${response.status}`);
        const data = await response.json();
        const rawLikes = data.records || [];
        if (rawLikes.length === 0) {
            likesContainer.innerHTML = `
        <div style="text-align:center; padding:40px 20px; color:rgb(171,184,201); font-size:15px; font-family:InterVariable,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
          No likes yet
        </div>
      `;
            return;
        }
        // Fetch post content for each liked post
        const likes = await Promise.all(rawLikes.map(async (like) => ({
            ...like,
            postContent: await getPostContent(like.value.subject.uri),
        })));
        // Collect unique author DIDs and batch-fetch their profiles (handles + avatars)
        const authorDids = [...new Set(likes.map((like) => {
                const [, , author] = like.value.subject.uri.split("/");
                return author;
            }))];
        const profiles = await getProfiles(authorDids);
        // Build feed items
        const feedHtml = likes
            .map((like) => {
            const [, , author] = like.value.subject.uri.split("/");
            const postId = like.value.subject.uri.split("/").pop();
            const profile = profiles.get(author);
            const authorHandle = profile?.handle || author;
            const avatarUrl = profile?.avatarUrl;
            const postUrl = `https://bsky.app/profile/${authorHandle}/post/${postId}`;
            const text = like.postContent?.text || "";
            const embedAny = like.postContent?.embed;
            const isImages = embedAny?.$type === 'app.bsky.embed.images' || embedAny?.media?.$type === 'app.bsky.embed.images';
            const isVideo = embedAny?.$type === 'app.bsky.embed.video' || embedAny?.media?.$type === 'app.bsky.embed.video';
            // Avatar: show image if we have one, otherwise fall back to letter circle
            const initial = authorHandle.charAt(0).toUpperCase();
            const avatarHtml = avatarUrl
                ? `<img src="${avatarUrl}" alt="${initial}" style="width:100%; height:100%; border-radius:50%; object-fit:cover;" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" loading="lazy"><div style="display:none; width:100%; height:100%; align-items:center; justify-content:center; color:rgb(171,184,201); font-size:14px; font-weight:600; position:absolute; top:0; left:0;">${initial}</div>`
                : initial;
            let mediaHtml = '';
            if (isImages) {
                const imagesList = (embedAny?.images || embedAny?.media?.images || []);
                const thumbnails = imagesList.map((img, i) => {
                    const thumbUrl = getCdnUrl(author, img.image, 'feed_thumbnail');
                    const fullUrl = getCdnUrl(author, img.image, 'feed_fullsize');
                    const ratio = img.aspectRatio || { width: 1, height: 1 };
                    const aspectPercent = ((ratio.height / ratio.width) * 100).toFixed(2);
                    return `<div style="position:relative; width:100%; margin-bottom:4px; border-radius:12px; overflow:hidden;" onclick="event.stopPropagation(); window.open('${fullUrl}', '_blank')">
              <div style="position:relative; width:100%; padding-bottom:${aspectPercent}%;">
                <img src="${thumbUrl}" alt="${escapeHtml(img.alt || 'Image')}" loading="lazy" style="position:absolute; top:0; left:0; width:100%; height:100%; object-fit:cover; border-radius:12px;" onerror="this.parentElement.parentElement.style.display='none'">
              </div>
            </div>`;
                }).join('');
                mediaHtml = `<div style="margin-top:8px; display:grid; grid-template-columns:${imagesList.length > 1 ? ' 1fr 1fr' : '1fr'}; gap:4px;">${thumbnails}</div>`;
            }
            else if (isVideo) {
                const videoBlob = embedAny?.video;
                if (videoBlob) {
                    const cid = videoBlob.ref.$link;
                    const playlistUrl = getVideoPlaylistUrl(author, cid);
                    const posterUrl = getVideoThumbnailUrl(author, cid);
                    const ratio = embedAny?.aspectRatio || { width: 16, height: 9 };
                    const aspectPercent = ((ratio.height / ratio.width) * 100).toFixed(2);
                    // Use a unique ID so we can target the video element for HLS init
                    const videoId = `bsky-video-${postId}`;
                    mediaHtml = `<div style="position:relative; width:100%; margin-top:8px; border-radius:12px; overflow:hidden;" onclick="event.stopPropagation();">
              <div style="position:relative; width:100%; padding-bottom:${aspectPercent}%;">
                <video id="${videoId}" poster="${posterUrl}" controls playsinline style="position:absolute; top:0; left:0; width:100%; height:100%; border-radius:12px;" onclick="event.stopPropagation();" data-hls-url="${playlistUrl}"></video>
              </div>
            </div>`;
                }
            }
            const createdAt = new Date(like.value.createdAt).toLocaleString();
            return `
          <div style="
            box-sizing: border-box;
            padding: 16px;
            border-bottom: 1px solid rgb(46,55,67);
            cursor: pointer;
            transition: background-color 0.2s;
          " onmouseover="this.style.backgroundColor='rgba(255,255,255,0.03)'" onmouseout="this.style.backgroundColor='transparent'" onclick="window.open('${postUrl.replace(/'/g, "\\'")}', '_blank')">
            <div style="display:flex; align-items:flex-start; gap:12px;">
              <div style="
                width: 40px; height: 40px;
                border-radius: 50%;
                background: rgb(46,55,67);
                flex-shrink: 0;
                position: relative;
                overflow: hidden;
              ">
                ${avatarHtml}
              </div>
              <div style="flex:1; min-width:0;">
                <div style="display:flex; align-items:baseline; gap:4px; margin-bottom:4px;">
                  <span style="
                    color: rgb(247,247,247);
                    font-weight: 600;
                    font-size: 15px;
                    font-family: InterVariable, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
                    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
                  ">@${authorHandle}</span>
                  <span style="
                    color: rgb(139,148,164);
                    font-size: 13px;
                    font-family: InterVariable, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
                    flex-shrink: 0;
                  ">· ${createdAt}</span>
                </div>
                <div style="
                  color: rgb(247,247,247);
                  font-size: 15px;
                  line-height: 20px;
                  font-family: InterVariable, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
                  white-space: pre-wrap;
                  word-break: break-word;
                  margin-bottom: ${(isImages || isVideo) ? "0" : "0"};
                ">${escapeHtml(text) || "[no text]"}</div>
                ${mediaHtml}
                <div style="display:flex; align-items:center; margin-top:12px; color:rgb(139,148,164); font-size:13px;">
                  <svg style="width:16px; height:16px; margin-right:4px; fill:rgb(200,57,97);" viewBox="0 0 24 24">
                    <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
                  </svg>
                  Liked
                </div>
              </div>
            </div>
          </div>
        `;
        })
            .join("");
        likesContainer.innerHTML = `
      <div style="
        box-sizing: border-box;
        width: 100%;
        color: rgb(247,247,247);
        font-family: InterVariable, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      ">
        ${feedHtml}
      </div>
    `;
        // Initialize HLS for all video elements after they're in the DOM
        initVideoPlayers(likesContainer);
    }
    catch (error) {
        likesContainer.innerHTML = `
      <div style="text-align:center; padding:40px 20px; color:rgb(200,57,97); font-size:15px; font-family:InterVariable,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
        Error loading likes: ${escapeHtml(error.message)}
      </div>
    `;
    }
}
function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
}
function removeLikesContainer() {
    const container = activeLikesContainer || document.getElementById("bsky-likes-feed");
    if (container) {
        container.remove();
        activeLikesContainer = null;
    }
}
// Initialize HLS.js on all video elements that have a data-hls-url attribute
async function initVideoPlayers(container) {
    const videos = container.querySelectorAll("video[data-hls-url]");
    if (videos.length === 0)
        return;
    try {
        const Hls = await loadHlsJs();
        videos.forEach((video) => {
            const hlsUrl = video.getAttribute("data-hls-url");
            if (!hlsUrl)
                return;
            if (Hls.isSupported()) {
                const hls = new Hls();
                hls.loadSource(hlsUrl);
                hls.attachMedia(video);
                hls.on(Hls.Events.MANIFEST_PARSED, () => {
                    // Video is ready to play
                });
            }
            else if (video.canPlayType("application/vnd.apple.mpegurl")) {
                // Safari native HLS support
                video.src = hlsUrl;
            }
        });
    }
    catch {
        // hls.js failed to load - videos will show poster only
    }
}
// ── Likes tab injection into profile pager ──────────────────────────────────
let likesTabInjected = false;
function selectTab(tab) {
    // Deselect all tabs
    const tablist = document.querySelector('[data-testid="profilePager"]');
    if (!tablist)
        return;
    const allTabs = tablist.querySelectorAll('[role="tab"]');
    allTabs.forEach((t) => {
        const label = t.querySelector('[dir="auto"]');
        if (label) {
            label.style.color = "rgb(171, 184, 201)";
            label.style.fontWeight = "600";
        }
        // Remove blue underline
        const underline = t.querySelector('[style*="background-color: rgb(15, 115, 255)"]');
        if (underline)
            underline.remove();
        t.setAttribute("aria-selected", "false");
    });
    // Select this tab
    const label = tab.querySelector('[dir="auto"]');
    if (label) {
        label.style.color = "rgb(255, 255, 255)";
        label.style.fontWeight = "600";
    }
    // Add blue underline to the label element
    if (label) {
        const underline = document.createElement("div");
        underline.className = "css-g5y9jx r-xoduu5 r-1p0dtai r-1hlnpa r-1wyvozj r-1i1dynu r-u8s1d r-1sffzi r-13qz1uu";
        underline.style.cssText = "background-color: rgb(15, 115, 255);";
        label.appendChild(underline);
    }
    tab.setAttribute("aria-selected", "true");
}
function createLikesTab() {
    const tab = document.createElement("div");
    tab.setAttribute("role", "tab");
    tab.setAttribute("tabindex", "0");
    tab.setAttribute("data-testid", "profilePager-selector-4");
    tab.className = "css-g5y9jx r-1loqt21 r-1otgn73 r-1oszu61 r-16y2uox r-1777fci r-gu64tb r-5t7p9m";
    const outerDiv = document.createElement("div");
    outerDiv.className = "css-g5y9jx r-1awozwy r-11yh6sk";
    const label = document.createElement("div");
    label.setAttribute("dir", "auto");
    label.className = "css-146c3p1";
    label.setAttribute("data-testid", "profilePager-Likes");
    label.style.cssText = `
    font-size: 15px;
    letter-spacing: 0px;
    color: rgb(171, 184, 201);
    text-align: center;
    padding-bottom: 13px;
    font-weight: 600;
    line-height: 20px;
    font-family: InterVariable, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji";
    font-variant: no-contextual unicode;
  `;
    label.textContent = "Likes";
    outerDiv.appendChild(label);
    tab.appendChild(outerDiv);
    tab.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const pathParts = window.location.pathname.split("/");
        const handle = pathParts[1] === "profile" ? pathParts[2] : null;
        if (!handle)
            return;
        selectTab(tab);
        fetchAndRenderLikes(handle);
    });
    // Keyboard support
    tab.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            tab.click();
        }
    });
    return tab;
}
function injectLikesTab() {
    if (likesTabInjected)
        return;
    const tablist = document.querySelector('[data-testid="profilePager"]');
    if (!tablist)
        return;
    // Check if Likes tab already exists
    if (tablist.querySelector('[data-testid="profilePager-Likes"]')) {
        likesTabInjected = true;
        return;
    }
    const selectorDiv = tablist.querySelector('[data-testid="profilePager-selector"]');
    if (!selectorDiv)
        return;
    const likesTab = createLikesTab();
    selectorDiv.appendChild(likesTab);
    likesTabInjected = true;
}
// Watch for native tab clicks to restore native content
function watchNativeTabs() {
    const tablist = document.querySelector('[data-testid="profilePager"]');
    if (!tablist)
        return;
    const nativeTabs = tablist.querySelectorAll('[role="tab"]:not([data-testid="profilePager-selector-4"])');
    nativeTabs.forEach((tab) => {
        if (tab.dataset.bskyWatched)
            return;
        tab.dataset.bskyWatched = "1";
        tab.addEventListener("click", () => {
            // When a native tab is clicked, remove likes container
            // React will handle showing the correct native content
            removeLikesContainer();
        });
    });
}
// ── Context menu items (existing functionality) ─────────────────────────────
function createMenuItem(text, onClick) {
    const item = document.createElement("button");
    item.style.cssText = `
    text-align: left;
    width: 100%;
    padding: 8px 16px;
    font: inherit;
    font-size: 14px;
    border: none;
    background: none;
    cursor: pointer;
    display: block;
    border-radius: 4px;
    color: rgb(247, 247, 247);
  `;
    item.addEventListener("mouseover", () => {
        item.style.backgroundColor = "rgba(255, 255, 255, 0.1)";
    });
    item.addEventListener("mouseout", () => {
        item.style.backgroundColor = "transparent";
    });
    item.textContent = text;
    item.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
    };
    return item;
}
async function addMenuItems() {
    const menu = document.querySelector('div[role="menu"]');
    if (!menu || document.querySelector("#bsky-tools-menu")) {
        return;
    }
    const pathParts = window.location.pathname.split("/");
    const handle = pathParts[1] === "profile" ? pathParts[2] : null;
    if (!handle)
        return;
    try {
        const did = await getDid(handle);
        const menuContainer = document.createElement("div");
        menuContainer.id = "bsky-tools-menu";
        menuContainer.style.cssText = `
      background: rgb(39, 39, 42);
      border-radius: 8px;
      padding: 4px;
      margin-top: 8px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
    `;
        const showLikesItem = createMenuItem("Show Likes", () => {
            fetchAndRenderLikes(handle);
            menu.remove();
        });
        const copyDidItem = createMenuItem("Copy DID", () => {
            navigator.clipboard.writeText(did);
            menu.remove();
        });
        const tools = [
            {
                name: "ATP Browser",
                url: `https://atproto-browser.vercel.app/at/${did}`,
            },
            { name: "PDSls", url: `https://pdsls.dev/at/${did}` },
            { name: "Internect", url: `https://internect.info/did/${did}` },
            { name: "PLC Tracker", url: `https://pht.kpherox.dev/did/${did}` },
            {
                name: "SkyTools",
                url: `https://skytools.anon5r.com/history?id=${did}`,
            },
        ];
        menuContainer.appendChild(showLikesItem);
        menuContainer.appendChild(copyDidItem);
        tools.forEach((tool) => {
            const button = createMenuItem(tool.name, () => {
                window.open(tool.url, "_blank");
                menu.remove();
            });
            menuContainer.appendChild(button);
        });
        menu.appendChild(menuContainer);
    }
    catch (error) {
        console.error("Error adding menu items:", error);
    }
}
// ── Observers ────────────────────────────────────────────────────────────────
// Observer for context menu
const menuObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
        const nodes = Array.from(mutation.addedNodes);
        for (const node of nodes) {
            if (node instanceof HTMLElement) {
                if (node.getAttribute("role") === "menu" ||
                    node.querySelector('div[role="menu"]')) {
                    setTimeout(addMenuItems, 0);
                }
            }
        }
    }
});
// Observer for profile page changes (tablist appearing, URL changes)
const profileObserver = new MutationObserver(() => {
    // Reset injection flag if tablist isn't on the page anymore
    const tablist = document.querySelector('[data-testid="profilePager"]');
    if (!tablist) {
        likesTabInjected = false;
        removeLikesContainer();
        return;
    }
    // Check if Likes tab still exists (React may have re-rendered and removed it)
    if (!tablist.querySelector('[data-testid="profilePager-Likes"]')) {
        likesTabInjected = false;
    }
    if (!likesTabInjected) {
        injectLikesTab();
    }
    // Watch native tabs
    watchNativeTabs();
});
// ── Initialization ──────────────────────────────────────────────────────────
function init() {
    menuObserver.observe(document, {
        childList: true,
        subtree: true,
    });
    profileObserver.observe(document, {
        childList: true,
        subtree: true,
    });
    // Initial injection if already on a profile page
    if (document.querySelector('[data-testid="profilePager"]')) {
        injectLikesTab();
        watchNativeTabs();
    }
}
// Run on load
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
}
else {
    init();
}
