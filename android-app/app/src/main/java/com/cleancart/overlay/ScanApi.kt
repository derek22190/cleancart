package com.cleancart.overlay

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.UUID

/** Minimal HTTP client for POST /api/scan and /api/referral (no third-party dependencies). */
object ScanApi {
    private val customBase = BuildConfig.API_BASE.trim().trimEnd('/')
    private val ENDPOINTS = listOfNotNull(
        customBase.takeIf { it.isNotBlank() }?.let { "$it/api/scan" },
        "https://www.heybroc.com/api/scan",
        "https://heybroc.com/api/scan",
        "https://cleancart-teal.vercel.app/api/scan",
    ).distinct()
    private val REFERRAL_ENDPOINTS = listOfNotNull(
        customBase.takeIf { it.isNotBlank() }?.let { "$it/api/referral" },
        "https://www.heybroc.com/api/referral",
        "https://heybroc.com/api/referral",
        "https://cleancart-teal.vercel.app/api/referral",
    ).distinct()
    private val SUGGEST_ENDPOINTS = listOfNotNull(
        customBase.takeIf { it.isNotBlank() }?.let { "$it/api/suggest" },
        "https://www.heybroc.com/api/suggest",
        "https://heybroc.com/api/suggest",
        "https://cleancart-teal.vercel.app/api/suggest",
    ).distinct()
    private val AUDIT_ENDPOINTS = listOfNotNull(
        customBase.takeIf { it.isNotBlank() }?.let { "$it/api/audit" },
        "https://www.heybroc.com/api/audit",
        "https://heybroc.com/api/audit",
        "https://cleancart-teal.vercel.app/api/audit",
    ).distinct()
    private val TRUSTED_HOSTS = setOfNotNull(
        runCatching { URL(customBase).host.lowercase() }.getOrNull()?.takeIf { it.isNotBlank() },
        "www.heybroc.com",
        "heybroc.com",
        "cleancart-teal.vercel.app",
    )

    private const val PREFS_NAME = "ingredient_preferences"
    private const val KEY_INSTALL_UUID = "install_uuid_v2"
    private const val KEY_DEVICE_SECRET = "device_secret_v1"
    private const val KEY_SERVER_REF_CODE = "server_referral_code"
    private const val KEY_PRO_ACTIVE = "entitlement_pro_active"
    private const val KEY_PRO_UNTIL = "entitlement_pro_until"
    private const val KEY_SWAPS_REMAINING = "entitlement_swaps_remaining"
    private const val KEY_SWAPS_LIMIT = "entitlement_swaps_limit"
    private const val KEY_PAYWALL_HEADLINE = "entitlement_paywall_headline"
    private const val KEY_PAYWALL_VARIANT = "entitlement_paywall_variant"
    private const val KEY_UNLOCKED_SWAP_PRODUCTS = "unlocked_swap_products_v1"
    private const val DEFAULT_FREE_WEEKLY_SWAPS = 3

    /** Blocking call — returns up to 8 live product suggestions from GET /api/suggest?q=<query>. */
    fun suggest(rawQuery: String): List<JSONObject> {
        val q = rawQuery.trim()
        if (q.isEmpty()) return emptyList()
        val encoded = URLEncoder.encode(q, "UTF-8")
        for (base in SUGGEST_ENDPOINTS) {
            try {
                val url = URL("$base?q=$encoded")
                val conn = (url.openConnection() as HttpURLConnection).apply {
                    requestMethod = "GET"
                    connectTimeout = 2500
                    readTimeout = 3500
                    setRequestProperty("Accept", "application/json")
                }
                try {
                    if (conn.responseCode in 200..299) {
                        val body = conn.inputStream.bufferedReader().use(BufferedReader::readText)
                        val arr = JSONObject(body).optJSONArray("suggestions") ?: continue
                        val out = ArrayList<JSONObject>(arr.length())
                        for (i in 0 until arr.length()) {
                            arr.optJSONObject(i)?.let { out.add(it) }
                        }
                        if (out.isNotEmpty()) return out
                    }
                } finally {
                    conn.disconnect()
                }
            } catch (_: Exception) {
                // try next endpoint
            }
        }
        return emptyList()
    }

    private const val MAX_CACHE_SIZE = 250
    private val prewarmExecutor = java.util.concurrent.Executors.newFixedThreadPool(2)
    private val inFlightPrewarms = java.util.Collections.synchronizedSet(HashSet<String>())
    private val responseCache = object : LinkedHashMap<String, String>(96, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, String>?): Boolean =
            size > MAX_CACHE_SIZE
    }

    /**
     * Install-scoped random UUID (never reads hardware Settings.Secure.ANDROID_ID).
     */
    fun deviceId(ctx: Context): String {
        val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val cached = prefs.getString(KEY_INSTALL_UUID, null)
        if (!cached.isNullOrBlank()) return cached
        val generated = UUID.randomUUID().toString()
        prefs.edit().putString(KEY_INSTALL_UUID, generated).apply()
        return generated
    }

    fun deviceSecret(ctx: Context): String {
        val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val cached = prefs.getString(KEY_DEVICE_SECRET, null)
        if (!cached.isNullOrBlank()) return cached
        val generated = UUID.randomUUID().toString() + "-" + UUID.randomUUID().toString()
        prefs.edit().putString(KEY_DEVICE_SECRET, generated).apply()
        return generated
    }

    /** Persists server-authoritative entitlement fields returned by /api/scan or /api/referral. */
    fun saveEntitlementSnapshot(ctx: Context, ent: JSONObject?) {
        if (ent == null) return
        val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val edit = prefs.edit()
        if (ent.has("isProActive")) {
            edit.putBoolean(KEY_PRO_ACTIVE, ent.optBoolean("isProActive", false))
        }
        if (ent.has("proUntil")) {
            edit.putLong(KEY_PRO_UNTIL, ent.optLong("proUntil", 0L))
        }
        if (ent.has("swapsRemaining")) {
            edit.putInt(KEY_SWAPS_REMAINING, ent.optInt("swapsRemaining", DEFAULT_FREE_WEEKLY_SWAPS))
        }
        if (ent.has("weeklySwapsLimit")) {
            edit.putInt(KEY_SWAPS_LIMIT, ent.optInt("weeklySwapsLimit", DEFAULT_FREE_WEEKLY_SWAPS))
        }
        val pwHeadline = ent.optString("paywallHeadline").trim()
        if (pwHeadline.isNotBlank() && pwHeadline != "null") {
            edit.putString(KEY_PAYWALL_HEADLINE, pwHeadline)
        }
        val pwVariant = ent.optString("paywallVariant").trim()
        if (pwVariant == "A" || pwVariant == "B") {
            edit.putString(KEY_PAYWALL_VARIANT, pwVariant)
        }
        val refCode = ent.optString("referralCode").trim()
        if (refCode.startsWith("BROC-")) {
            edit.putString(KEY_SERVER_REF_CODE, refCode)
        }
        edit.apply()
    }

    fun paywallHeadline(ctx: Context): String {
        val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return prefs.getString(KEY_PAYWALL_HEADLINE, null)
            ?.takeIf { it.isNotBlank() }
            ?: "Unlock Unlimited Clean Swaps"
    }

    fun weeklySwapsLimit(ctx: Context): Int {
        val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return prefs.getInt(KEY_SWAPS_LIMIT, DEFAULT_FREE_WEEKLY_SWAPS).coerceAtLeast(1)
    }

    /** Non-blocking first-party funnel event ping to /api/analytics (forwarded server-side to PostHog). */
    fun trackEvent(ctx: Context, eventName: String, properties: JSONObject? = null) {
        val appCtx = ctx.applicationContext
        Thread {
            runCatching {
                val prefs = appCtx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                val variant = prefs.getString(KEY_PAYWALL_VARIANT, "A") ?: "A"
                val body = JSONObject().apply {
                    put("action", "track")
                    put("event", eventName)
                    put("deviceId", deviceId(appCtx))
                    put("platform", "android")
                    put("variant", variant)
                    if (properties != null) {
                        put("properties", properties)
                    }
                }.toString()
                postFollowingRedirects("https://www.heybroc.com/api/analytics", body, maxRedirects = 2)
            }
        }.start()
    }

    fun isProActive(ctx: Context): Boolean {
        val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val proFlag = prefs.getBoolean(KEY_PRO_ACTIVE, false)
        val proUntil = prefs.getLong(KEY_PRO_UNTIL, 0L)
        return if (proUntil > 0L) proUntil > System.currentTimeMillis() else proFlag
    }

    fun swapsRemaining(ctx: Context): Int {
        if (isProActive(ctx)) return Int.MAX_VALUE
        val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val limit = weeklySwapsLimit(ctx)
        return prefs.getInt(KEY_SWAPS_REMAINING, DEFAULT_FREE_WEEKLY_SWAPS).coerceIn(0, limit)
    }

    fun canUseSwap(ctx: Context): Boolean {
        return isProActive(ctx) || swapsRemaining(ctx) > 0
    }

    private fun normalizeSwapKey(raw: String): String =
        raw.lowercase().replace(Regex("[^a-z0-9]+"), " ").trim().take(80)

    fun isSwapUnlocked(ctx: Context, productTitle: String, swapTitle: String = ""): Boolean {
        if (isProActive(ctx)) return true
        val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val unlocked = prefs.getStringSet(KEY_UNLOCKED_SWAP_PRODUCTS, emptySet()).orEmpty()
        val pKey = normalizeSwapKey(productTitle)
        val sKey = normalizeSwapKey(swapTitle)
        return (pKey.isNotBlank() && pKey in unlocked) || (sKey.isNotBlank() && sKey in unlocked)
    }

    fun unlockSwapForProduct(ctx: Context, productTitle: String, swapTitle: String): Boolean {
        if (isSwapUnlocked(ctx, productTitle, swapTitle)) return true
        if (!canUseSwap(ctx)) return false
        consumeSwap(ctx, swapTitle, productTitle)
        return true
    }

    /** Decrements local swap counter when on free tier and records the swap asynchronously on the server. */
    fun consumeSwap(ctx: Context, swapTitle: String, productTitle: String = "") {
        val appCtx = ctx.applicationContext
        val prefs = appCtx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val alreadyUnlocked = isSwapUnlocked(appCtx, productTitle, swapTitle)
        val nextUnlocked = prefs.getStringSet(KEY_UNLOCKED_SWAP_PRODUCTS, emptySet()).orEmpty().toMutableSet()
        normalizeSwapKey(productTitle).takeIf { it.isNotBlank() }?.let { nextUnlocked.add(it) }
        normalizeSwapKey(swapTitle).takeIf { it.isNotBlank() }?.let { nextUnlocked.add(it) }
        val editor = prefs.edit().putStringSet(KEY_UNLOCKED_SWAP_PRODUCTS, nextUnlocked)
        if (!isProActive(appCtx) && !alreadyUnlocked) {
            val limit = weeklySwapsLimit(appCtx)
            val current = prefs.getInt(KEY_SWAPS_REMAINING, DEFAULT_FREE_WEEKLY_SWAPS).coerceIn(0, limit)
            editor.putInt(KEY_SWAPS_REMAINING, (current - 1).coerceAtLeast(0))
        }
        editor.apply()
        if (alreadyUnlocked) return
        Thread {
            runCatching {
                val body = JSONObject().apply {
                    put("action", "record_swap")
                    put("deviceId", deviceId(appCtx))
                    put("deviceSecret", deviceSecret(appCtx))
                    put("productKey", swapTitle.trim().take(120))
                }.toString()
                for (endpoint in REFERRAL_ENDPOINTS) {
                    try {
                        val res = postFollowingRedirects(
                            endpoint,
                            body,
                            maxRedirects = 4,
                            extraHeaders = mapOf("X-Device-Secret" to deviceSecret(appCtx))
                        )
                        if (res.startsWith("{")) {
                            val json = JSONObject(res)
                            saveEntitlementSnapshot(appCtx, json.optJSONObject("entitlement"))
                            break
                        }
                    } catch (_: Exception) {
                        // try next endpoint
                    }
                }
            }
        }.start()
    }

    /** Returns the server-issued BROC-XXXXXXXX invite code if available. */
    fun myReferralCode(ctx: Context): String {
        val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val serverCode = prefs.getString(KEY_SERVER_REF_CODE, null)
        if (!serverCode.isNullOrBlank()) return serverCode
        val clean = deviceId(ctx).replace(Regex("[^a-zA-Z0-9]"), "").uppercase()
        var hash = 2166136261.toInt()
        for (ch in clean) {
            hash = hash xor ch.code
            hash *= 16777619
        }
        val alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
        var v = hash.toLong() and 0xFFFFFFFFL
        val suffix = StringBuilder()
        for (i in 0 until 8) {
            suffix.append(alphabet[((v xor (i * 31L)) and 0x7FFFFFFFL).toInt() % alphabet.length])
            v = (v shr 4) xor (v * 33L)
        }
        return "BROC-$suffix"
    }

    fun referredByCode(ctx: Context): String? {
        val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return prefs.getString("referredByCode", null)?.takeIf { it.isNotBlank() }
    }

    fun getReferredByCode(ctx: Context): String? = referredByCode(ctx)

    fun saveReferredByCode(ctx: Context, rawCode: String): String {
        val trimmed = rawCode.trim()
        val extracted = Regex("""(?:[?&](?:code|ref)=|/r/)([A-Za-z0-9_-]+)""", RegexOption.IGNORE_CASE)
            .find(trimmed)
            ?.groupValues
            ?.getOrNull(1)
            ?: trimmed
        val clean = extracted.uppercase()
            .replace(Regex("[^A-Z0-9_-]"), "")
            .take(40)
        if (clean.isNotBlank()) {
            val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            prefs.edit().putString("referredByCode", clean).apply()
        }
        return clean
    }

    /** Blocking call — claims a friend's invite code on /api/referral. */
    fun claimReferral(ctx: Context, rawCode: String): String {
        val clean = saveReferredByCode(ctx, rawCode)
        if (clean.isBlank()) return """{"ok":false,"error":"Invalid referral code"}"""
        val secret = deviceSecret(ctx)
        val body = JSONObject().apply {
            put("action", "claim")
            put("deviceId", deviceId(ctx))
            put("deviceSecret", secret)
            put("referralCode", clean)
            put("referredByCode", clean)
        }.toString()
        for (endpoint in REFERRAL_ENDPOINTS) {
            try {
                val res = postFollowingRedirects(
                    endpoint,
                    body,
                    maxRedirects = 4,
                    extraHeaders = mapOf("X-Device-Secret" to secret)
                )
                if (res.startsWith("{")) {
                    runCatching {
                        saveEntitlementSnapshot(ctx, JSONObject(res).optJSONObject("entitlement"))
                    }
                    return res
                }
            } catch (_: Exception) {
                // try next endpoint
            }
        }
        return """{"ok":true,"offlineSaved":true}"""
    }

    data class DietaryOption(
        val id: String,
        val emoji: String,
        val title: String,
        val subtitle: String,
        val shortBadge: String,
    ) {
        val key: String get() = id
        val icon: String get() = emoji
        val label: String get() = title
    }

    data class DietaryAlert(
        val id: String,
        val label: String,
        val shortBadge: String,
        val reason: String,
    ) {
        val icon: String get() = label.substringBefore(" ")
        val matchedDetail: String get() = reason
    }

    private val GOOGLE_VERIFY_ENDPOINTS = listOfNotNull(
        customBase.takeIf { it.isNotBlank() }?.let { "$it/api/google/verify" },
        "https://www.heybroc.com/api/google/verify",
        "https://heybroc.com/api/google/verify",
    ).distinct()

    /** Blocking call — verifies a Google Play subscription purchase token and syncs Pro entitlement. */
    fun verifyGooglePlayPurchase(
        ctx: Context,
        purchaseToken: String,
        productId: String,
        orderId: String = ""
    ): JSONObject? {
        val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val authToken = prefs.getString("auth_token", null)?.trim()
        val creatorCode = referredByCode(ctx)
        val body = JSONObject().apply {
            put("purchaseToken", purchaseToken)
            put("productId", productId)
            put("packageName", ctx.packageName)
            if (orderId.isNotBlank()) put("orderId", orderId)
            put("deviceId", deviceId(ctx))
            if (!authToken.isNullOrBlank()) put("token", authToken)
            if (!creatorCode.isNullOrBlank()) put("creatorCode", creatorCode)
        }.toString()
        val headers = mutableMapOf("X-Device-Secret" to deviceSecret(ctx))
        if (!authToken.isNullOrBlank()) {
            headers["Authorization"] = "Bearer $authToken"
        }
        for (endpoint in GOOGLE_VERIFY_ENDPOINTS) {
            try {
                val res = postFollowingRedirects(
                    endpoint,
                    body,
                    maxRedirects = 4,
                    extraHeaders = headers
                )
                if (res.startsWith("{")) {
                    val json = JSONObject(res)
                    if (json.optBoolean("active", false)) {
                        // Keys must match saveEntitlementSnapshot (isProActive / proUntil); the old
                        // isPro / expiresAtMs keys were silently ignored, so Pro wasn't persisted locally.
                        val entObj = JSONObject().apply {
                            put("isProActive", true)
                            put("proUntil", json.optLong("expiresAtMs", 0L))
                        }
                        saveEntitlementSnapshot(ctx, entObj)
                    }
                    return json
                }
            } catch (_: Exception) {
                // try next endpoint
            }
        }
        return null
    }

    val DIETARY_OPTIONS = listOf(
        DietaryOption(
            id = "sugar_diabetes",
            emoji = "🩸",
            title = "Sugar / Diabetes Watch",
            subtitle = "Flags added sugars, corn syrup/HFCS, >=10g sugar/100g, or refined starches",
            shortBadge = "SUGAR"
        ),
        DietaryOption(
            id = "pesticide_risk",
            emoji = "🌱",
            title = "Herbicides & Pesticides (Glyphosate) Watch",
            subtitle = "Flags non-organic Dirty-Dozen produce & conventional oats/wheat/legumes (glyphosate desiccant risk); swaps to USDA Organic",
            shortBadge = "PESTICIDE"
        ),
        DietaryOption(
            id = "dairy",
            emoji = "🥛",
            title = "Dairy / Lactose Allergy",
            subtitle = "Flags milk, cream, butter, whey, casein, lactose, cheese & yogurt",
            shortBadge = "DAIRY"
        ),
        DietaryOption(
            id = "wheat_gluten",
            emoji = "🌾",
            title = "Wheat / Gluten Allergy",
            subtitle = "Flags wheat, enriched flour, barley, malt, rye, spelt & semolina",
            shortBadge = "WHEAT"
        ),
        DietaryOption(
            id = "peanuts_nuts",
            emoji = "🥜",
            title = "Peanut & Tree Nut Allergy",
            subtitle = "Flags peanuts, almonds, cashews, walnuts, pecans, hazelnuts & pistachios",
            shortBadge = "NUTS"
        ),
        DietaryOption(
            id = "soy",
            emoji = "🫘",
            title = "Soy Allergy",
            subtitle = "Flags soy, soybean oil, soy lecithin, soy protein, tofu & edamame",
            shortBadge = "SOY"
        ),
        DietaryOption(
            id = "egg",
            emoji = "🥚",
            title = "Egg Allergy",
            subtitle = "Flags whole egg, egg whites/yolks, albumin & mayonnaise",
            shortBadge = "EGG"
        ),
        DietaryOption(
            id = "shellfish_fish",
            emoji = "🐟",
            title = "Shellfish & Fish Allergy",
            subtitle = "Flags shrimp, crab, lobster, clams, anchovies, salmon, tuna & cod",
            shortBadge = "FISH"
        ),
        DietaryOption(
            id = "sesame",
            emoji = "🥯",
            title = "Sesame Allergy",
            subtitle = "Flags sesame seeds, sesame oil, tahini, halvah & sesamol",
            shortBadge = "SESAME"
        ),
        DietaryOption(
            id = "high_sodium",
            emoji = "🧂",
            title = "High Sodium / Blood Pressure",
            subtitle = "Flags >=400mg sodium/100g, MSG, sodium phosphate & added brine",
            shortBadge = "SODIUM"
        ),
    )

    /**
     * Evaluates the user's opt-in Personal Allergy & Diabetes Watchlist against a scanned product.
     * Returns an empty list when no boxes are checked (all unchecked by default).
     */
    private val PRECAUTIONARY_PREFIX_RE = Regex(
        "\\b(?:may\\s+contain(?:\\s+traces\\s+of)?|(?:manufactured|processed|produced|packaged|made|prepared)\\s+(?:in|on)\\s+(?:a\\s+)?(?:facility|plant|bakery|kitchen|equipment|shared\\s+equipment|lines?|machinery)\\s+(?:that|which)\\s+(?:also\\s+)?(?:processes|handles|uses|manufactures|packages)|(?:(?:manufactured|processed|produced|packaged|made|prepared)\\s+(?:on|in)\\s+)?(?:shared\\s+equipment|(?:a\\s+)?(?:equipment|lines?|machinery|facility|plant)\\s+shared)\\s+with|facility\\s+that\\s+(?:also\\s+)?(?:processes|handles|uses|manufactures|packages))(?:\\s*:)?\\s+(?:traces\\s+of\\s+)?(?:the\\s+following\\s*:?\\s*)?",
        RegexOption.IGNORE_CASE
    )

    private val SINGLE_PRECAUTIONARY_ALLERGEN_HEAD_RE = Regex(
        "^(?:other\\s+|various\\s+|trace\\s+|traces\\s+of\\s+)?(?:peanuts?|tree\\s+nuts?|nuts?|almonds?|walnuts?|pecans?|cashews?|hazelnuts?|filberts?|pistachios?|macadamia(?:\\s+nuts?)?|brazil\\s+nuts?|pine\\s+nuts?|chestnuts?|coconuts?|milk|dairy|lactose|whey|casein|eggs?|wheat|gluten|barley|rye|oats?|triticale|spelt|soy|soya|soybeans?|soy\\s+lecithin|soya\\s+lecithin|lecithin\\s+soy(?:a|bean)?|sesame(?:\\s+seeds?)?|(?:crustacean\\s+|molluscan\\s+)?shellfish|crustaceans?|mollusks?|molluscs?|fish|finfish|anchov(?:y|ies)|salmon|tuna|cod|shrimp|crab|lobster|mustard|celery|sulfites?|sulphites?|sulfur\\s+dioxide|lupin|lupine|allergens?)(?:\\s+(?:products?|ingredients?|derivatives?|traces?|proteins?|sources?))?$",
        RegexOption.IGNORE_CASE
    )

    private val PRECAUTIONARY_SECTION_STOP_RE = Regex(
        "^(?:,\\s*)?(?:ingredients?|contains|distributed|manufactured|produced|packaged|questions|allergen)\\b",
        RegexOption.IGNORE_CASE
    )

    private val PRECAUTIONARY_HEADER_BEFORE_RE = Regex(
        "(?:^|[.;!?\\n(\\[\\-|/])\\s*(?:allergen(?:\\s+(?:information|warning|statement|advisory))?|allergy(?:\\s+(?:information|warning|advisory))?|cross[\\s-]*contact(?:\\s+warning)?)\\s*:?\\s*$",
        RegexOption.IGNORE_CASE
    )

    private val CONJ_AFTER_COMMA_RE = Regex("^(?:and|or)\\b\\s+", RegexOption.IGNORE_CASE)
    private val CONJ_INLINE_RE = Regex("^\\s+(?:and(?:\\s*/\\s*or)?|or)\\s+", RegexOption.IGNORE_CASE)

    private fun splitPrecautionaryListItems(listText: String): List<String>? {
        val items = ArrayList<String>()
        val cur = StringBuilder()
        var depth = 0
        var i = 0
        while (i < listText.length) {
            val ch = listText[i]
            if (ch == '(') {
                depth += 1
                cur.append(ch)
                i += 1
                continue
            }
            if (ch == ')') {
                if (depth == 0) return null
                depth -= 1
                cur.append(ch)
                i += 1
                continue
            }
            if (depth == 0) {
                if (ch == ',' || ch == '&' || ch == '/') {
                    val trimmed = cur.toString().trim()
                    if (trimmed.isNotEmpty()) items.add(trimmed)
                    cur.setLength(0)
                    var nextIdx = i + 1
                    while (nextIdx < listText.length && listText[nextIdx].isWhitespace()) nextIdx += 1
                    if (ch == ',') {
                        val conj = CONJ_AFTER_COMMA_RE.find(listText.substring(nextIdx))
                        if (conj != null) nextIdx += conj.value.length
                    }
                    i = nextIdx
                    continue
                }
                if (ch.isWhitespace()) {
                    val conj = CONJ_INLINE_RE.find(listText.substring(i))
                    if (conj != null) {
                        val trimmed = cur.toString().trim()
                        if (trimmed.isNotEmpty()) items.add(trimmed)
                        cur.setLength(0)
                        i += conj.value.length
                        continue
                    }
                }
            }
            cur.append(ch)
            i += 1
        }
        if (depth != 0) return null
        val tail = cur.toString().trim()
        if (tail.isNotEmpty()) items.add(tail)
        return items.takeIf { it.isNotEmpty() }
    }

    private fun isPrecautionaryAllergenSegment(segment: String): Boolean {
        val trimmed = segment.trim().replace(Regex("^[:\\-–—]+\\s*"), "").trim()
        if (trimmed.isEmpty() || trimmed.length > 160) return false
        val parenIdx = trimmed.indexOf('(')
        if (parenIdx == -1) {
            return !trimmed.contains(')') && SINGLE_PRECAUTIONARY_ALLERGEN_HEAD_RE.matches(trimmed)
        }
        if (!trimmed.endsWith(')')) return false
        val head = trimmed.substring(0, parenIdx).trim()
        val inner = trimmed.substring(parenIdx + 1, trimmed.length - 1).trim()
        if (head.isEmpty() || inner.isEmpty() || inner.contains('(') || inner.contains(')')) return false
        if (!SINGLE_PRECAUTIONARY_ALLERGEN_HEAD_RE.matches(head)) return false
        val subItems = splitPrecautionaryListItems(inner) ?: return false
        return subItems.all { sub -> SINGLE_PRECAUTIONARY_ALLERGEN_HEAD_RE.matches(sub.trim()) }
    }

    private fun isStandalonePrecautionaryStart(text: String, matchStart: Int): Boolean {
        var k = matchStart - 1
        while (k >= 0 && (text[k] == ' ' || text[k] == '\t')) k -= 1
        if (k < 0) return true
        if (text[k] in ".;!?\n([-|/:") return true
        val beforeSlice = text.substring((matchStart - 48).coerceAtLeast(0), matchStart)
        return PRECAUTIONARY_HEADER_BEFORE_RE.containsMatchIn(beforeSlice)
    }

    fun stripPrecautionaryCrossContactClauses(text: String): String {
        if (text.isEmpty()) return ""
        val out = StringBuilder()
        var lastEmit = 0
        var searchIdx = 0
        while (searchIdx < text.length) {
            val m = PRECAUTIONARY_PREFIX_RE.find(text, searchIdx) ?: break
            val matchStart = m.range.first
            val bodyStart = m.range.last + 1
            val isStandalone = isStandalonePrecautionaryStart(text, matchStart)
            var depth = 0
            var clauseEnd = text.length
            var trailingCommaBeforeSection = false
            for (i in bodyStart until text.length) {
                val ch = text[i]
                if (ch == '(') {
                    depth += 1
                    continue
                }
                if (ch == ')') {
                    if (depth == 0) {
                        clauseEnd = i
                        break
                    }
                    depth -= 1
                    continue
                }
                if (depth == 0) {
                    if (ch == '.' || ch == ';' || ch == '!' || ch == '?' || ch == '\n' || ch == ']') {
                        clauseEnd = i
                        break
                    }
                    if (!isStandalone && ch == ',') {
                        clauseEnd = i
                        break
                    }
                    if (
                        (ch == ',' || i == bodyStart || text[i - 1].isWhitespace()) &&
                        PRECAUTIONARY_SECTION_STOP_RE.containsMatchIn(
                            text.substring(i, (i + 32).coerceAtMost(text.length))
                        )
                    ) {
                        clauseEnd = i
                        trailingCommaBeforeSection = ch == ','
                        break
                    }
                }
            }
            if (depth == 0 && clauseEnd > bodyStart) {
                val candidateBody = text.substring(bodyStart, clauseEnd).trim()
                val segments = splitPrecautionaryListItems(candidateBody)
                if (segments != null && segments.all { isPrecautionaryAllergenSegment(it) }) {
                    val stripEnd = if (trailingCommaBeforeSection) clauseEnd + 1 else clauseEnd
                    out.append(text, lastEmit, matchStart).append(' ')
                    lastEmit = stripEnd
                    searchIdx = stripEnd.coerceAtLeast(matchStart + 1)
                    continue
                }
            }
            searchIdx = bodyStart.coerceAtLeast(matchStart + 1)
        }
        if (lastEmit == 0) return text
        out.append(text, lastEmit, text.length)
        return out.toString()
    }

    fun stripFreeFromClaims(text: String): String {
        if (text.isBlank()) return ""
        return text
            .replace(
                Regex(
                    "\\b(?:gluten|wheat)[\\s-]*free(?:\\s+(?:all[\\s-]*purpose|baking|blend|1[\\s-]*to[\\s-]*1|measure[\\s-]*for[\\s-]*measure))?\\s+flour\\b",
                    RegexOption.IGNORE_CASE
                ),
                " "
            )
            .replace(
                Regex(
                    "\\b(?:peanuts?|tree\\s+nuts?|nuts?|eggs?|dairy|milk|lactose|soy|sesame|wheat|gluten|grains?|shellfish|fish|allergens?)(?:\\s*(?:,|&|and|or|/)\\s*(?:peanuts?|tree\\s+nuts?|nuts?|eggs?|dairy|milk|lactose|soy|sesame|wheat|gluten|grains?|shellfish|fish|allergens?))*\\s*[\\s-]+free\\b",
                    RegexOption.IGNORE_CASE
                ),
                " "
            )
            .replace(
                Regex(
                    "\\b(?:free\\s+(?:from|of)|without|no)\\s+(?:peanuts?|tree\\s+nuts?|nuts?|eggs?|dairy|milk|lactose|soy(?:\\s+lecithin)?|sesame|wheat|gluten)(?:\\s*(?:,|&|and|or|/)\\s*(?:peanuts?|tree\\s+nuts?|nuts?|eggs?|dairy|milk|lactose|soy(?:\\s+lecithin)?|sesame|wheat|gluten))*\\b",
                    RegexOption.IGNORE_CASE
                ),
                " "
            )
    }

    fun evaluateDietaryAlerts(
        ctx: Context,
        productJson: JSONObject?,
        resultJson: JSONObject? = null,
        rootDataJson: JSONObject? = null,
    ): List<DietaryAlert> {
        val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val selected = prefs.getStringSet("dietaryWatchlist", emptySet()).orEmpty()
        if (selected.isEmpty()) return emptyList()

        val activeWatchlistSig = selected.sorted().joinToString(",")
        val serverArr = rootDataJson?.optJSONArray("dietaryAlerts") ?: resultJson?.optJSONArray("dietaryAlerts")
        val serverDietarySig = when {
            rootDataJson?.has("_serverDietaryWatchlistSig") == true -> rootDataJson.optString("_serverDietaryWatchlistSig")
            resultJson?.has("_serverDietaryWatchlistSig") == true -> resultJson.optString("_serverDietaryWatchlistSig")
            else -> null
        }

        fun parseServerAlerts(arr: JSONArray): List<DietaryAlert> {
            val parsed = ArrayList<DietaryAlert>()
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                val id = o.optString("id")
                if (id in selected && parsed.none { it.id == id }) {
                    parsed.add(
                        DietaryAlert(
                            id = id,
                            label = o.optString("label", "⚠️ Dietary Alert"),
                            shortBadge = o.optString("shortBadge", "ALERT"),
                            reason = o.optString("reason", "Flagged by your personal watchlist")
                        )
                    )
                }
            }
            return parsed
        }

        if (serverArr != null && serverDietarySig != null && serverDietarySig == activeWatchlistSig) {
            return parseServerAlerts(serverArr)
        }

        val title = productJson?.optString("title").orEmpty()
        val ingredients = productJson?.optString("ingredients").orEmpty()
        val nutrition = productJson?.optJSONObject("nutrition")
        val hasIngredients = ingredients.isNotBlank()
        val ing = stripFreeFromClaims(stripPrecautionaryCrossContactClauses(ingredients).lowercase())
        val cleanTitleForAlerts = stripFreeFromClaims(title.lowercase())
        val text = "$cleanTitleForAlerts $ing".trim()

        if (title.isBlank() && ingredients.isBlank()) {
            return if (serverArr != null) parseServerAlerts(serverArr) else emptyList()
        }

        val alerts = ArrayList<DietaryAlert>()

        if ("sugar_diabetes" in selected) {
            val sugarsG = nutrition?.optDouble("sugarsG100g", 0.0) ?: 0.0
            val ingCleanedForSugar = ing.replace(
                Regex(
                    "\\b(no\\s+(?:added\\s+)?sugars?|sugar[\\s-]*free|zero\\s+sugar|unsweetened|without\\s+(?:added\\s+)?sugar|0\\s*g\\s+sugar|sugar\\s+alcohols?|sugar\\s+snap(?:\\s+peas?)?|sugar\\s+kelp|sugar\\s+pumpkin)\\b",
                    RegexOption.IGNORE_CASE
                ),
                " "
            )
            val sugarMatch = Regex(
                "\\b(high\\s+fructose\\s+corn\\s+syrup|corn\\s+syrup|cane\\s+sugar|brown\\s+sugar|sugar|sucrose|dextrose|maltose|fructose|glucose\\s+syrup|honey|maple\\s+syrup|molasses|agave|invert\\s+sugar|fruit\\s+juice\\s+concentrate)\\b",
                RegexOption.IGNORE_CASE
            ).find(ingCleanedForSugar)
            val refinedCarbMatch = Regex(
                "\\b(enriched\\s+(?:wheat\\s+)?flour|bleached\\s+(?:wheat\\s+)?flour|maltodextrin|modified\\s+(?:corn|food)\\s+starch|instant\\s+mashed|white\\s+rice\\s+flour)\\b",
                RegexOption.IGNORE_CASE
            ).find(ing)
            val titleClaimsSugarFreeOrUnsweetened = Regex(
                "\\b(zero\\s+sugar|sugar[\\s-]*free|unsweetened|\\bdiet\\b)\\b",
                RegexOption.IGNORE_CASE
            ).containsMatchIn(title)
            val triggersIntrinsicSugar =
                sugarsG >= 10.0 &&
                    !(titleClaimsSugarFreeOrUnsweetened &&
                        Regex("\\bunsweetened\\b", RegexOption.IGNORE_CASE).containsMatchIn(title) &&
                        sugarMatch == null &&
                        refinedCarbMatch == null &&
                        sugarsG <= 12.0)
            if ((hasIngredients || !titleClaimsSugarFreeOrUnsweetened) &&
                (triggersIntrinsicSugar || sugarMatch != null || refinedCarbMatch != null)
            ) {
                val reasons = ArrayList<String>()
                if (sugarsG >= 10.0) reasons.add("${sugarsG.toInt()}g sugar per 100g")
                if (sugarMatch != null) {
                    reasons.add("Added sweetener (${sugarMatch.value.lowercase()})")
                } else if (refinedCarbMatch != null) {
                    reasons.add("Refined starch (${refinedCarbMatch.value.lowercase()})")
                }
                alerts.add(
                    DietaryAlert(
                        id = "sugar_diabetes",
                        label = "🩸 Sugar / Diabetes Watch",
                        shortBadge = "SUGAR",
                        reason = reasons.joinToString(" • ")
                    )
                )
            }
        }

        // Never let front-of-pack "Non-Dairy" / "Plant-Based" / "Gluten-Free" / "Vegan" claims suppress
        // actual ingredient-list scanning (e.g. Coffee-mate "Non-Dairy" containing sodium caseinate).
        if ("dairy" in selected) {
            val titleClaimsDairyFree = Regex(
                "\\b(dairy[\\s-]*free|non[\\s-]*dairy|milk[\\s-]*free|plant[\\s-]*based|vegan)\\b",
                RegexOption.IGNORE_CASE
            ).containsMatchIn(title)
            val dairySource = if (titleClaimsDairyFree) ing else text
            if (dairySource.isNotBlank()) {
                val cleanedDairyText = dairySource.replace(
                    Regex(
                        "\\b(dairy[\\s-]*free|non[\\s-]*dairy|milk[\\s-]*free|lactose[\\s-]*free|butter[\\s-]*free|whey[\\s-]*free|casein[\\s-]*free|no\\s+(?:dairy|milk|lactose|butter|whey|casein)|plant\\s+(?:milk|butter|cream\\w*|cheese|yogurt)|vegan\\s+(?:milk|butter|cream\\w*|cheese|yogurt)|coconut\\s+milk|almond\\s+milk|oat\\s+milk|soy\\s+milk|soymilk|almondmilk|oatmilk|rice\\s+milk|cashew\\s*milk|walnut\\s*milk|hazelnut\\s*milk|pistachio\\s*milk|pecan\\s*milk|macadamia\\s*milk|hemp\\s*milk|pea\\s*milk|flax\\s*milk|banana\\s*milk|oat\\s+beverage|almond\\s+beverage|soy\\s+beverage|coconut\\s+beverage|milked\\s+\\w+|milk\\s+thistle|peanut\\s+butter|almond\\s+butter|cashew\\s+butter|hazelnut\\s+butter|walnut\\s+butter|pecan\\s+butter|pistachio\\s+butter|macadamia\\s+butter|sunflower\\s+(?:seed\\s+)?butter|sunbutter|pumpkin\\s+seed\\s+butter|sesame\\s+butter|cocoa\\s+butter|shea\\s+butter|mango\\s+butter|apple\\s+butter|pumpkin\\s+butter|cookie\\s+butter|fruit\\s+butter|butter\\s+beans?|butter\\s+lettuce|butter\\s+potato\\w*|butternut(?:\\s+squash)?|cream\\s+of\\s+(?:tartar|coconut|rice|wheat)|cream\\s+soda|coconut\\s+cream\\w*|oat\\s+cream\\w*|almond\\s+cream\\w*|soy\\s+cream\\w*|plant\\s+cream\\w*|lactic\\s+acid|calcium\\s+lactate|sodium\\s+lactate|sodium\\s+stearoyl\\s+lactylate|(?:bean|soy|tofu)\\s+curds?)\\b",
                        RegexOption.IGNORE_CASE
                    ),
                    " "
                )
                val m = Regex(
                    "\\b(buttermilk|sour\\s+cream|half\\s+and\\s+half|milk|milkfat|butterfat|butteroil|cream|butter|whey|casein|caseinate|sodium\\s+caseinate|calcium\\s+caseinate|lactose|cheese|cheddar|mozzarella|parmesan|provolone|gouda|swiss|ricotta|paneer|curds?|yogurt|ghee|lactalbumin|lactoglobulin)\\b",
                    RegexOption.IGNORE_CASE
                ).find(cleanedDairyText)
                if (m != null) {
                    alerts.add(
                        DietaryAlert(
                            id = "dairy",
                            label = "🥛 Dairy / Lactose Alert",
                            shortBadge = "DAIRY",
                            reason = "Contains ${m.value.lowercase()}"
                        )
                    )
                }
            }
        }

        if ("wheat_gluten" in selected) {
            val titleClaimsGlutenFree = Regex(
                "\\b(gluten[\\s-]*free|grain[\\s-]*free|wheat[\\s-]*free|celiac)\\b",
                RegexOption.IGNORE_CASE
            ).containsMatchIn(title)
            val glutenSource = if (titleClaimsGlutenFree) ing else text
            if (glutenSource.isNotBlank()) {
                val cleanedGlutenText = glutenSource
                    .replace(
                        Regex(
                            "\\b(?:(?:organic|whole\\s+grain|brown|white|sweet|yellow|blue|green|red|defatted|toasted|blanched|roasted|stone[\\s-]*ground|fine|superfine|sprouted|gluten[\\s-]*free)\\s+)*(?:almond|coconut|rice|oat|corn|masa|cassava|tapioca|chickpea|garbanzo(?:\\s+bean)?|potato|buckwheat|sorghum|quinoa|pea|peanut|soy|soya|hazelnut|chestnut|amaranth|teff|millet|banana|plantain|tiger\\s*nut|flax(?:\\s*seed)?|hemp|sunflower(?:\\s*seed)?|lupin|lupine|konjac|arrowroot|sesame|lentil|bean|fava\\s+bean|chia|mesquite|cauliflower|carob)\\s+flour\\b|\\bgluten[\\s-]*free(?:\\s+all[\\s-]*purpose|\\s+baking|\\s+blend)?\\s+flour\\b",
                            RegexOption.IGNORE_CASE
                        ),
                        " "
                    )
                    .replace(
                        Regex(
                            "\\b(buckwheat|wheat\\s*grass|wheat[\\s-]*free|gluten[\\s-]*free(?:\\s+oats?)?|no\\s+(?:wheat|gluten)|corn\\s+gluten)\\b",
                            RegexOption.IGNORE_CASE
                        ),
                        " "
                    )
                val m = Regex(
                    "\\b(vital\\s+wheat\\s+gluten|graham\\s+flour|enriched\\s+flour|bleached\\s+flour|unbleached\\s+flour|matz[ao]h?\\s+meal|panko|einkorn|wheat|durum|semolina|spelt|farro|kamut|bulgur|couscous|seitan|barley|malt|malted|rye|triticale|flour)\\b",
                    RegexOption.IGNORE_CASE
                ).find(cleanedGlutenText)
                if (m != null) {
                    alerts.add(
                        DietaryAlert(
                            id = "wheat_gluten",
                            label = "🌾 Wheat / Gluten Alert",
                            shortBadge = "WHEAT",
                            reason = "Contains ${m.value.lowercase()}"
                        )
                    )
                }
            }
        }

        if ("peanuts_nuts" in selected) {
            val titleClaimsNutFree = Regex(
                "\\b(nut[\\s-]*free|peanut[\\s-]*free|tree\\s+nut[\\s-]*free|no\\s+(?:peanuts?|tree\\s+nuts?|nuts?))\\b",
                RegexOption.IGNORE_CASE
            ).containsMatchIn(title)
            val nutSource = if (titleClaimsNutFree) ing else text
            val cleanedNutText = nutSource.replace(
                Regex(
                    "\\b(nutmeg|butternut|water\\s+chestnuts?|coconuts?|nut[\\s-]*free|peanut[\\s-]*free|tree\\s+nut[\\s-]*free)\\b",
                    RegexOption.IGNORE_CASE
                ),
                " "
            )
            val m = Regex(
                "\\b(peanut\\s+butter|peanut\\s+oil|peanut\\s+flour|arachis\\s+oil|groundnuts?|peanuts?|tree\\s+nuts?|almonds?|almondmilk|cashews?|cashewmilk|walnuts?|walnutmilk|pecans?|pecanmilk|hazelnuts?|hazelnutmilk|filberts?|pistachios?|pistachiomilk|macadamias?|macadamiamilk|chestnuts?|brazil\\s+nuts?|pine\\s+nuts?|praline|marzipan|nougat|gianduja)\\b",
                RegexOption.IGNORE_CASE
            ).find(cleanedNutText)
            if (m != null) {
                alerts.add(
                    DietaryAlert(
                        id = "peanuts_nuts",
                        label = "🥜 Peanut & Tree Nut Alert",
                        shortBadge = "NUTS",
                        reason = "Contains ${m.value.lowercase()}"
                    )
                )
            }
        }

        if ("soy" in selected) {
            val titleClaimsSoyFree = Regex("\\b(soy[\\s-]*free|no\\s+soy)\\b", RegexOption.IGNORE_CASE).containsMatchIn(title)
            val soySource = if (titleClaimsSoyFree) ing else text
            if (soySource.isNotBlank()) {
                val cleanedSoyText = soySource.replace(
                    Regex("\\b(soy[\\s-]*free|no\\s+soy(?:\\s+lecithin)?|without\\s+soy|free\\s+of\\s+soy)\\b", RegexOption.IGNORE_CASE),
                    " "
                )
                val m = Regex(
                    "\\b(soybean\\s+oil|soy\\s+lecithin|soy\\s+protein|soy\\s+flour|soy\\s+sauce|textured\\s+vegetable\\s+protein|soybeans?|soymilk|soy|soya|tamari|shoyu|natto|tofu|tempeh|edamame|miso)\\b",
                    RegexOption.IGNORE_CASE
                ).find(cleanedSoyText)
                if (m != null) {
                    alerts.add(
                        DietaryAlert(
                            id = "soy",
                            label = "🫘 Soy Alert",
                            shortBadge = "SOY",
                            reason = "Contains ${m.value.lowercase()}"
                        )
                    )
                }
            }
        }

        if ("egg" in selected) {
            val titleClaimsEggFree = Regex("\\b(egg[\\s-]*free|no\\s+eggs?|vegan)\\b", RegexOption.IGNORE_CASE).containsMatchIn(title)
            val eggSource = if (titleClaimsEggFree) ing else text
            if (eggSource.isNotBlank()) {
                val cleanedEggText = eggSource.replace(
                    Regex("\\b(eggplants?|egg[\\s-]*free(?:\\s+vegan)?(?:\\s+mayo(?:nnaise)?)?|no\\s+eggs?|vegan\\s+mayo(?:nnaise)?|eggless(?:\\s+mayonnaise)?)\\b", RegexOption.IGNORE_CASE),
                    " "
                )
                val m = Regex(
                    "\\b(egg\\s+whites?|egg\\s+yolks?|dried\\s+egg|powdered\\s+egg|eggs?|albumen|albumin|ovalbumin|ovomucoid|lysozyme|mayonnaise|aioli|meringue)\\b",
                    RegexOption.IGNORE_CASE
                ).find(cleanedEggText)
                if (m != null) {
                    alerts.add(
                        DietaryAlert(
                            id = "egg",
                            label = "🥚 Egg Alert",
                            shortBadge = "EGG",
                            reason = "Contains ${m.value.lowercase()}"
                        )
                    )
                }
            }
        }

        if ("shellfish_fish" in selected) {
            val titleClaimsFishFree = Regex("\\b(shellfish[\\s-]*free|fish[\\s-]*free|seafood[\\s-]*free|vegan)\\b", RegexOption.IGNORE_CASE).containsMatchIn(title)
            val fishSource = if (titleClaimsFishFree) ing else text
            val m = Regex(
                "\\b((?:crustacean\\s+|molluscan\\s+)?shellfish|crustaceans?|mollusks?|molluscs?|shrimp|prawns?|crab|lobster|langostino|crawfish|crayfish|clams?|mussels?|oysters?|scallops?|calamari|squid|octopus|anchov(?:y|ies)|sardines?|salmon|tuna|cod|tilapia|halibut|haddock|trout|mahi|pollock|catfish|bonito(?:\\s+flakes)?|surimi|krill|fish\\s+sauce|fish\\s+oil)\\b",
                RegexOption.IGNORE_CASE
            ).find(fishSource)
            if (m != null) {
                alerts.add(
                    DietaryAlert(
                        id = "shellfish_fish",
                        label = "🐟 Shellfish & Fish Alert",
                        shortBadge = "FISH",
                        reason = "Contains ${m.value.lowercase()}"
                    )
                )
            }
        }

        if ("sesame" in selected) {
            val titleClaimsSesameFree = Regex("\\b(sesame[\\s-]*free|no\\s+sesame)\\b", RegexOption.IGNORE_CASE).containsMatchIn(title)
            val sesameSource = if (titleClaimsSesameFree) ing else text
            if (sesameSource.isNotBlank()) {
                val cleanedSesameText = sesameSource.replace(
                    Regex("\\b(sesame[\\s-]*free|no\\s+sesame|without\\s+sesame|free\\s+of\\s+sesame)\\b", RegexOption.IGNORE_CASE),
                    " "
                )
                val m = Regex(
                    "\\b(sesame\\s+seeds?|sesame\\s+oil|sesame\\s+flour|sesame\\s+paste|tahini|sesame|benne\\s+seeds?|gingelly|gomasio|halvah|halva|sesamol|sesamolin)\\b",
                    RegexOption.IGNORE_CASE
                ).find(cleanedSesameText)
                if (m != null) {
                    alerts.add(
                        DietaryAlert(
                            id = "sesame",
                            label = "🌱 Sesame Alert",
                            shortBadge = "SESAME",
                            reason = "Contains ${m.value.lowercase()}"
                        )
                    )
                }
            }
        }

        if ("high_sodium" in selected) {
            val sodiumMg = nutrition?.optDouble("sodiumMg100g", 0.0) ?: 0.0
            val sodiumAddMatch = Regex(
                "\\b(monosodium\\s+glutamate|(?:di|tri|mono|penta)?sodium\\s+(?:(?:dihydrogen|acid|aluminum|hexameta|tripoly|pyro|poly)\\s+)?(?:phosphates?|triphosphate|tripolyphosphate|pyrophosphate|hexametaphosphate|polyphosphates?)|disodium\\s+inosinate|disodium\\s+guanylate|sodium\\s+nitrite|sodium\\s+nitrate|sodium\\s+benzoate|sodium\\s+caseinate|brine|saline\\s+solution)\\b",
                RegexOption.IGNORE_CASE
            ).find(ing)
            if (sodiumMg >= 400.0 || sodiumAddMatch != null) {
                val reasons = ArrayList<String>()
                if (sodiumMg >= 400.0) reasons.add("${sodiumMg.toInt()}mg sodium per 100g")
                if (sodiumAddMatch != null) reasons.add("Contains ${sodiumAddMatch.value.lowercase()}")
                alerts.add(
                    DietaryAlert(
                        id = "high_sodium",
                        label = "🧂 High Sodium Watch",
                        shortBadge = "SODIUM",
                        reason = reasons.joinToString(" • ")
                    )
                )
            }
        }

        if ("pesticide_risk" in selected) {
            val yukaObj = resultJson?.optJSONObject("yukaBreakdown")
            val pestMatch = detectPesticideRisk(title, ing, nutrition, productJson, yukaObj)
            if (pestMatch != null) {
                val reasonText = if (pestMatch.kind == "high_residue_produce") {
                    "Conventional ${pestMatch.matchedCrop} (-${pestMatch.points} pts) — high-residue produce category in USDA Pesticide Data Program (Dirty Dozen); choose USDA Organic (7 CFR § 205.105)"
                } else {
                    "Conventional ${pestMatch.matchedCrop} (-${pestMatch.points} pts) — non-organic crop permits synthetic herbicides & desiccants (such as glyphosate); choose USDA Organic (7 CFR § 205.105)"
                }
                alerts.add(
                    DietaryAlert(
                        id = "pesticide_risk",
                        label = "🌱 Herbicides & Pesticides (Glyphosate) Watch",
                        shortBadge = "PESTICIDE",
                        reason = reasonText
                    )
                )
            }
        }

        if (serverArr != null && serverDietarySig == null) {
            for (srv in parseServerAlerts(serverArr)) {
                if (alerts.none { it.id == srv.id }) {
                    alerts.add(srv)
                }
            }
        }
        return alerts
    }

    private const val PESTICIDE_PRODUCE_DEDUCTION = 25
    private const val PESTICIDE_PRODUCE_SCORE_CAP = 65
    private const val PESTICIDE_GRAIN_DEDUCTION = 20
    private const val PESTICIDE_GRAIN_SCORE_CAP = 69

    private data class PesticidePenaltyMatch(
        val kind: String,
        val matchedCrop: String,
        val points: Int,
        val maxScoreCap: Int
    )

    private fun detectPesticideRisk(
        title: String,
        ing: String,
        nutrition: JSONObject?,
        productJson: JSONObject?,
        yuka: JSONObject? = null
    ): PesticidePenaltyMatch? {
        val hasIngredients = ing.length >= 3
        val cleanTitleForAlerts = title
            .replace(Regex("\\bsponsored(?:\\s+ad)?\\b", RegexOption.IGNORE_CASE), " ")
            .replace(Regex("\\s+"), " ")
            .trim()
        // Never infer whole-product USDA Organic from an individual ingredient (e.g. "organic cane sugar"
        // in conventional oatmeal) or from negated "Non-Organic" titles.
        val sanitizedTitleForOrganic = title
            .replace(Regex("\\bnon[\\s-]*organic\\b", RegexOption.IGNORE_CASE), " ")
            .replace(Regex("\\b(?:made\\s+)?with\\s+organic\\s+[a-z]+(?:\\s+[a-z]+){0,2}\\b", RegexOption.IGNORE_CASE), " ")
        val isCertifiedProductOrganic = (nutrition?.optBoolean("isOrganic", false) == true) ||
            (productJson?.optBoolean("isOrganic", false) == true) ||
            ((yuka?.optInt("organicScore", 0) ?: 0) > 0) ||
            Regex(
                "\\b(usda\\s+organic|certified\\s+organic|biodynamic|glyphosate[\\s-]*residue[\\s-]*free|pesticide[\\s-]*free|herbicide[\\s-]*free)\\b",
                RegexOption.IGNORE_CASE
            ).containsMatchIn(sanitizedTitleForOrganic) ||
            (!hasIngredients && Regex("\\b(organic|organics)\\b", RegexOption.IGNORE_CASE).containsMatchIn(sanitizedTitleForOrganic))
        val isBeverageOrCandy = Regex(
            "\\b(sparkling\\s+water|seltzer|club\\s+soda|energy\\s+drink|diet\\s+soda|cola|sprite|fanta|gatorade|powerade|chewing\\s+gum|gummy|gummies|skittles|starburst|sunscreen|lotion|shampoo|soap|detergent|toothpaste)\\b",
            RegexOption.IGNORE_CASE
        ).containsMatchIn(title) && !Regex("\\b(oats?|oatmeal|wheat|flour)\\b", RegexOption.IGNORE_CASE).containsMatchIn(ing)

        if (isCertifiedProductOrganic || isBeverageOrCandy) return null

        val riskSource = if (hasIngredients) ing else cleanTitleForAlerts
        val cleaned = riskSource
            .replace(Regex("\\bnon[\\s-]*organic\\b", RegexOption.IGNORE_CASE), "conventional")
            .replace(
                Regex("\\borganic\\s+(?:whole\\s+grain\\s+|rolled\\s+|steel[\\s-]*cut\\s+|sprouted\\s+|gluten[\\s-]*free\\s+|unbleached\\s+|enriched\\s+|durum\\s+|baby\\s+|fresh\\s+|frozen\\s+)?[a-z]+(?:\\s+(?:oats?|wheat|flour|strawberr\\w*|blueberr\\w*|spinach|kale|apples?|grapes?|peaches?|pears?|peppers?|cherries|beans?|potatoes?|celery|tomatoes?|chickpeas?|lentils?|semolina))?", RegexOption.IGNORE_CASE),
                " "
            )
            .replace(
                Regex("\\b(?:natural|artificial)\\s+[a-z\\s]{0,20}flavors?\\b|\\b(?:apple\\s+cider\\s+vinegar|apple\\s+pectin|fruit\\s+pectin|citrus\\s+pectin|tomato\\s+lycopene|grape\\s+skin\\s+extract|rosemary\\s+extract)\\b|\\b(?:(?:red|green|yellow|sweet|jalape[nñ]o|hot|chili|chilli)\\s+(?:(?:and|&|/)\\s+(?:red|green|yellow|sweet)\\s+)?)?(?:bell\\s+peppers?|sweet\\s+peppers?|jalape[nñ]o\\s+peppers?|hot\\s+peppers?|celery|tomato(?:es)?)\\s+(?:powder|seed|seeds|salt|extract|oleoresin|oil|flakes?)\\b", RegexOption.IGNORE_CASE),
                " "
            )
        val produceMatch = Regex(
            "\\b(strawberries|strawberry|baby\\s+spinach|spinach|kale|collard\\s+greens?|mustard\\s+greens?|seedless\\s+grapes?|grapes?|raisins?|peaches|peach|pears|pear|nectarines?|applesauce|apples?|bell\\s+peppers?|sweet\\s+peppers?|hot\\s+peppers?|cherries|blueberries|blueberry|green\\s+beans?|string\\s+beans?|potatoes|celery|tomatoes)\\b",
            RegexOption.IGNORE_CASE
        ).find(cleaned)
        if (produceMatch != null) {
            return PesticidePenaltyMatch(
                kind = "high_residue_produce",
                matchedCrop = produceMatch.value.lowercase(),
                points = PESTICIDE_PRODUCE_DEDUCTION,
                maxScoreCap = PESTICIDE_PRODUCE_SCORE_CAP
            )
        }
        val grainMatch = Regex(
            "\\b(rolled\\s+oats?|steel[\\s-]*cut\\s+oats?|whole\\s+grain\\s+oats?|instant\\s+oats?|oatmeal|oat\\s+flour|oat\\s+bran|oat\\s*milk|granola|oats|whole\\s+wheat(?:\\s+flour)?|enriched\\s+(?:wheat\\s+)?flour|bleached\\s+(?:wheat\\s+)?flour|unbleached\\s+(?:wheat\\s+)?flour|graham\\s+flour|durum\\s+wheat|semolina|wheat\\s+flour|chickpeas?|garbanzo\\s+beans?|hummus|lentils?|pinto\\s+beans?|black\\s+beans?|navy\\s+beans?|kidney\\s+beans?)\\b",
            RegexOption.IGNORE_CASE
        ).find(cleaned)
        if (grainMatch != null) {
            return PesticidePenaltyMatch(
                kind = "conventional_grain_legume",
                matchedCrop = grainMatch.value.lowercase(),
                points = PESTICIDE_GRAIN_DEDUCTION,
                maxScoreCap = PESTICIDE_GRAIN_SCORE_CAP
            )
        }
        return null
    }

    private const val KEY_SEED_OILS_ENABLED = "seed_oils_enabled_v1"
    private const val KEY_PREFER_STORE_BRAND = "prefer_store_brand_v1"

    fun isSeedOilsEnabled(ctx: Context): Boolean {
        val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return prefs.getBoolean(KEY_SEED_OILS_ENABLED, true)
    }

    fun setSeedOilsEnabled(ctx: Context, enabled: Boolean) {
        val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().putBoolean(KEY_SEED_OILS_ENABLED, enabled).apply()
    }

    fun isPreferStoreBrand(ctx: Context): Boolean {
        val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return prefs.getBoolean(KEY_PREFER_STORE_BRAND, false)
    }

    fun setPreferStoreBrand(ctx: Context, enabled: Boolean) {
        val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().putBoolean(KEY_PREFER_STORE_BRAND, enabled).apply()
    }

    fun currentWatchlistSignature(ctx: Context): String {
        val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val fw = prefs.getStringSet("familyWatchlist", emptySet()).orEmpty()
            .map { if (it == "nitrites") "nitrates" else it }
            .sorted()
            .joinToString(",")
        val dw = prefs.getStringSet("dietaryWatchlist", emptySet()).orEmpty()
            .sorted()
            .joinToString(",")
        val so = if (isSeedOilsEnabled(ctx)) "1" else "0"
        val psb = if (isPreferStoreBrand(ctx)) "1" else "0"
        return "$fw|$dw|so=$so|psb=$psb"
    }

    private fun resolveAdditiveCategory(item: JSONObject): String {
        val explicit = item.optString("category")
        if (explicit.isNotBlank()) return explicit
        val id = item.optString("id").lowercase()
        val name = item.optString("name").lowercase()
        return when {
            id in setOf("red3", "red40", "yellow5", "yellow6", "blue1", "blue2", "green3", "caramel_color", "caramelcolor", "tio2") ||
                Regex("\\b(red\\s*(40|3)|yellow\\s*(5|6)|blue\\s*(1|2)|green\\s*3|caramel\\s*color|titanium\\s*dioxide|artificial\\s*color)\\b").containsMatchIn(name) -> "dyes"
            id in setOf("hfcs", "corn_syrup", "cornsyrup") ||
                Regex("\\b(high[\\s-]*fructose\\s+corn\\s+syrup|hfcs|corn\\s+syrup)\\b").containsMatchIn(name) -> "hfcs"
            id in setOf("soybean_oil", "soybeanoil", "canola_oil", "canolaoil", "corn_oil", "cornoil", "cottonseed_oil", "cottonseedoil", "sunflower_oil", "sunfloweroil", "safflower_oil", "saffloweroil", "grapeseed_oil", "grapeseedoil", "rice_bran_oil", "ricebranoil", "vegetable_oil", "vegoil", "phoil", "hydrogoil") ||
                (id != "fully_hydrog_oil" && Regex("\\b(soybean|canola|rapeseed|corn|cottonseed|sunflower|safflower|grapeseed|rice\\s*bran|vegetable|(?<!fully\\s)hydrogenated)\\s+oil\\b", RegexOption.IGNORE_CASE).containsMatchIn(name)) -> "seedOils"
            id in setOf("nitrite", "sodium_nitrite", "nanitrite", "sodium_nitrate", "nanitrate", "celerynitrate", "potassium_nitrite", "potassium_nitrate") ||
                Regex("\\b(sodium\\s+nitrite|sodium\\s+nitrate|potassium\\s+nitrite|potassium\\s+nitrate|celery\\s+(powder|juice)|nitrates?|nitrites?)\\b").containsMatchIn(name) -> "nitrates"
            id in setOf("bha", "bht", "tbhq", "propylgallate", "propyl_gallate", "ada", "azodicarbonamide", "kbromate", "potassium_bromate", "propylparaben", "sulfites", "aluminum_additives", "sodium_benzoate", "nabenzoate", "potassium_sorbate", "ksorbate", "calcium_propionate", "capropionate", "propionates", "sodium_diacetate", "edta") ||
                Regex("\\b(bha|bht|tbhq|sodium\\s+benzoate|potassium\\s+sorbate|calcium\\s+propionate|potassium\\s+bromate|propylparaben|edta|butylated)\\b").containsMatchIn(name) -> "preservatives"
            id in setOf("sucralose", "aspartame", "ace_k", "acek", "saccharin", "neotame", "advantame", "cyclamate", "sugar_alcohols", "erythritol") ||
                Regex("\\b(sucralose|aspartame|acesulfame|ace[\\s-]*k|saccharin|neotame|advantame|cyclamate|erythritol)\\b").containsMatchIn(name) -> "sweeteners"
            id in setOf("bvo", "saib", "ester_gum", "fully_hydrog_oil", "polysorbate_80", "polysorbate80", "polysorbate_60", "polysorbate60", "polysorbate_40", "polysorbate40", "polysorbate_20", "polysorbate20", "carboxymethylcellulose", "cmc", "mono_diglycerides", "monodiglycerides", "datem", "ssl_csl", "ethoxylated_glycerides", "sodium_stearoyl_lactylate", "pgpr", "pga", "naphosphate", "phosphoric_acid", "carrageenan") ||
                Regex("\\b(polysorbate|carboxymethylcellulose|mono[\\s-]*and[\\s-]*diglycerides|datem|sodium\\s+stearoyl\\s+lactylate|pgpr|carrageenan)\\b").containsMatchIn(name) -> "emulsifiers"
            id in setOf("xanthan_gum", "xanthan", "guar_gum", "locust_bean_gum", "cellulose_gum", "gellan_gum", "soylecithin") ||
                Regex("\\b(xanthan\\s+gum|guar\\s+gum|locust\\s+bean\\s+gum|cellulose\\s+gum|gellan\\s+gum|soy\\s+lecithin)\\b").containsMatchIn(name) -> "gums"
            id in setOf("msg", "artificial_flavor", "artificialflavor", "natural_flavor", "naturalflavor", "autolyzed_yeast", "disodium_inosinate", "disodium_guanylate", "inosinate_guanylate", "yeast_hydrolyzed_protein") ||
                Regex("\\b(monosodium\\s+glutamate|msg|artificial\\s+flavors?|natural\\s+flavors?|autolyzed\\s+yeast|disodium\\s+inosinate|disodium\\s+guanylate)\\b").containsMatchIn(name) -> "flavors"
            else -> ""
        }
    }

    private fun defaultBasePenalty1x(id: String, name: String, risk: String): Int {
        val normId = id.lowercase()
        return when {
            risk == "high" -> 35
            normId == "nabenzoate" && name.contains("benzene", ignoreCase = true) -> 18
            normId in setOf("neotame", "advantame", "cyclamate") -> 16
            normId in setOf("sulfites", "aluminum_additives") -> 14
            normId in setOf("saib", "ester_gum") -> 12
            risk == "moderate" -> 20
            normId in setOf("fully_hydrog_oil", "pgpr", "pga", "capropionate", "propionates", "sodium_diacetate", "inosinate_guanylate", "yeast_hydrolyzed_protein", "sugar_alcohols") -> 8
            normId == "erythritol" -> 5
            normId == "phosphoric_acid" -> 4
            else -> 10
        }
    }

    private fun buildCombinedAdditiveSnapshot(result: JSONObject, currentFlagged: JSONArray): String {
        val skipped = result.optJSONArray("skipped")
        if (skipped == null || skipped.length() == 0) return currentFlagged.toString()
        val combined = JSONArray(currentFlagged.toString())
        val existingIds = HashSet<String>()
        for (i in 0 until combined.length()) {
            combined.optJSONObject(i)?.optString("id")?.takeIf { it.isNotEmpty() }?.let { existingIds.add(it) }
        }
        for (i in 0 until skipped.length()) {
            val sObj = skipped.optJSONObject(i) ?: continue
            val sId = sObj.optString("id")
            if (sId.isEmpty() || existingIds.add(sId)) {
                combined.put(JSONObject(sObj.toString()))
            }
        }
        return combined.toString()
    }

    private fun stampServerScanSnapshots(data: JSONObject, watchlistSig: String, dietarySig: String) {
        if (data.has("dietaryAlerts") && !data.has("_serverDietaryWatchlistSig")) {
            data.put("_serverDietaryWatchlistSig", dietarySig)
        }
        val result = data.optJSONObject("result") ?: return
        if (!result.has("_serverWatchlistSig")) {
            result.put("_serverWatchlistSig", watchlistSig)
            result.put("_serverScore", result.optInt("score", 50))
            result.put("_serverRating", result.optString("rating", ""))
            result.put("_serverColor", result.optString("color", ""))
            val flagged = result.optJSONArray("flagged")
            if (flagged != null) {
                result.put("_serverFlaggedExact", flagged.toString())
                result.put("_serverFlaggedSnapshot", buildCombinedAdditiveSnapshot(result, flagged))
            }
            result.optJSONObject("yukaBreakdown")?.let { yuka ->
                result.put("_serverAdditiveScore", yuka.optInt("additiveScore", 30))
                result.put("_serverHighRiskCapped", yuka.optBoolean("highRiskCapped", false))
                result.put("_serverPesticideDeduction", yuka.optInt("pesticideDeduction", 0))
            }
        }
    }

    /**
     * Re-evaluates a scan JSONObject in-place against the user's current Seed Oil toggle, familyWatchlist (2x strictness),
     * and Pesticide Watch (`pesticide_risk`) toggle.
     * When the local watchlist signature matches `_serverWatchlistSig`, restores the canonical server score untouched.
     */
    fun applyLocalWatchlistScoring(ctx: Context, data: JSONObject?) {
        val result = data?.optJSONObject("result") ?: return
        val yuka = result.optJSONObject("yukaBreakdown")
        if (yuka != null && yuka.optString("nutriScoreGrade") == "N/A") return
        val currentFlagged = result.optJSONArray("flagged") ?: return
        val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val seedOilsOn = isSeedOilsEnabled(ctx)
        val familySet = prefs.getStringSet("familyWatchlist", emptySet()).orEmpty()
            .map { if (it == "nitrites") "nitrates" else it }
            .filter { seedOilsOn || it != "seedOils" }
            .toSet()
        val pesticideWatchOn = "pesticide_risk" in prefs.getStringSet("dietaryWatchlist", emptySet()).orEmpty()
        val activeWatchlistSig = "$seedOilsOn|${familySet.sorted().joinToString(",")}|pest=${if (pesticideWatchOn) "1" else "0"}"

        if (!result.has("_serverWatchlistSig")) {
            result.put("_serverWatchlistSig", activeWatchlistSig)
            result.put("_serverScore", result.optInt("score", 50))
            result.put("_serverRating", result.optString("rating", ""))
            result.put("_serverColor", result.optString("color", ""))
            result.put("_serverFlaggedExact", currentFlagged.toString())
            result.put("_serverFlaggedSnapshot", buildCombinedAdditiveSnapshot(result, currentFlagged))
            if (yuka != null) {
                result.put("_serverAdditiveScore", yuka.optInt("additiveScore", 30))
                result.put("_serverHighRiskCapped", yuka.optBoolean("highRiskCapped", false))
                result.put("_serverPesticideDeduction", yuka.optInt("pesticideDeduction", 0))
            }
        }

        val serverWatchlistSig = result.optString("_serverWatchlistSig", activeWatchlistSig)
        if (activeWatchlistSig == serverWatchlistSig) {
            result.put("score", result.optInt("_serverScore", result.optInt("score", 50)))
            val srvRating = result.optString("_serverRating", "")
            if (srvRating.isNotBlank()) result.put("rating", srvRating)
            val srvColor = result.optString("_serverColor", "")
            if (srvColor.isNotBlank()) result.put("color", srvColor)
            val exactFlaggedStr = result.optString("_serverFlaggedExact", result.optString("_serverFlaggedSnapshot", currentFlagged.toString()))
            runCatching { JSONArray(exactFlaggedStr) }.getOrNull()?.let { result.put("flagged", it) }
            if (yuka != null && result.has("_serverAdditiveScore")) {
                yuka.put("additiveScore", result.optInt("_serverAdditiveScore", yuka.optInt("additiveScore", 30)))
                yuka.put("highRiskCapped", result.optBoolean("_serverHighRiskCapped", yuka.optBoolean("highRiskCapped", false)))
                val srvPestDed = result.optInt("_serverPesticideDeduction", 0)
                if (srvPestDed > 0) yuka.put("pesticideDeduction", srvPestDed) else yuka.remove("pesticideDeduction")
            }
            return
        }

        val origFlaggedStr = result.optString("_serverFlaggedSnapshot", currentFlagged.toString())
        val origFlagged = runCatching { JSONArray(origFlaggedStr) }.getOrDefault(currentFlagged)
        val serverFamilySet = serverWatchlistSig
            .substringAfter('|', "")
            .substringBefore('|')
            .split(',')
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .toSet()

        val activeFlagged = JSONArray()
        var strictnessDeduction = 0
        var hasHighOrMod2x = false
        var totalActivePenalty = 0
        var remainingNonNutriCount = 0
        var remainingHighRisk = false
        var remainingSeedOilCount = 0

        for (i in 0 until origFlagged.length()) {
            val rawItem = origFlagged.optJSONObject(i) ?: continue
            val item = JSONObject(rawItem.toString())
            val idStr = item.optString("id")
            if (idStr.startsWith("nutri_")) {
                activeFlagged.put(item)
                continue
            }
            val risk = item.optString("risk", "low")
            val cat = resolveAdditiveCategory(item)
            if (cat == "seedOils" && !seedOilsOn) {
                continue
            }
            val defaultBase = defaultBasePenalty1x(idStr, item.optString("name"), risk)
            val origPen = item.optInt("penalty", defaultBase)
            val origMult = when {
                item.has("watchlistMultiplier") -> item.optInt("watchlistMultiplier", 1)
                cat.isNotEmpty() && cat in serverFamilySet -> 2
                defaultBase > 0 && origPen >= defaultBase * 2 -> 2
                else -> 1
            }
            val basePen = if (origMult >= 2) origPen / 2 else origPen
            val is2x = cat.isNotEmpty() && cat in familySet
            val effectivePen = if (is2x) basePen * 2 else basePen
            item.put("penalty", effectivePen)
            totalActivePenalty += effectivePen
            remainingNonNutriCount++
            if (risk == "high") remainingHighRisk = true
            if (cat == "seedOils") remainingSeedOilCount++
            if (is2x) {
                strictnessDeduction += when (risk) {
                    "high" -> 12
                    "moderate" -> 10
                    else -> 6
                }
                if (risk == "high" || risk == "moderate") {
                    hasHighOrMod2x = true
                }
            }
            activeFlagged.put(item)
        }
        result.put("flagged", activeFlagged)

        val isIngredientOnly = result.optString("scoringBasis") == "ingredient-only" || yuka == null
        var nextScore: Int
        if (isIngredientOnly) {
            nextScore = (100 - totalActivePenalty).coerceIn(0, 100)
            if (remainingHighRisk) {
                nextScore = nextScore.coerceAtMost(49)
            }
        } else {
            val yukaObj = yuka!!
            val nutriScore = yukaObj.optInt("nutritionScore", 36)
            val orgScore = yukaObj.optInt("organicScore", 0)
            val hasBevSugarCap = yukaObj.optBoolean("beverageCapApplied", false)
            val multiDed = (remainingNonNutriCount - 1).coerceAtLeast(0) * 3
            val addDed = (Math.round(totalActivePenalty * 0.45f) + multiDed).coerceAtMost(30)
            val newAddScore = if (remainingHighRisk || hasHighOrMod2x) 0 else (30 - addDed).coerceAtLeast(0)
            yukaObj.put("additiveScore", newAddScore)
            yukaObj.put("highRiskCapped", remainingHighRisk)
            var pillarSum = (nutriScore + newAddScore + orgScore).coerceIn(0, 100)
            if (remainingHighRisk || remainingSeedOilCount >= 2 || hasBevSugarCap) {
                pillarSum = pillarSum.coerceAtMost(49)
            } else if (remainingSeedOilCount == 1) {
                pillarSum = pillarSum.coerceAtMost(59)
            }
            nextScore = pillarSum
            if (strictnessDeduction > 0) {
                if (hasHighOrMod2x) {
                    nextScore = nextScore.coerceAtMost(39)
                }
                nextScore = (nextScore - strictnessDeduction).coerceIn(0, 100)
            }
        }

        if (pesticideWatchOn) {
            val prod = data.optJSONObject("product")
            val titleForPest = prod?.optString("title").orEmpty()
            val ingForPest = prod?.optString("ingredients").orEmpty()
            val nutriForPest = prod?.optJSONObject("nutrition") ?: data.optJSONObject("nutrition")
            val pestPenalty = detectPesticideRisk(titleForPest, ingForPest, nutriForPest, prod, yuka)
            if (pestPenalty != null) {
                val adjusted = (nextScore - pestPenalty.points).coerceAtMost(pestPenalty.maxScoreCap).coerceIn(0, 100)
                val applied = (nextScore - adjusted).coerceAtLeast(0)
                nextScore = adjusted
                if (yuka != null) {
                    if (applied > 0) yuka.put("pesticideDeduction", applied) else yuka.remove("pesticideDeduction")
                }
            } else {
                yuka?.remove("pesticideDeduction")
            }
        } else {
            yuka?.remove("pesticideDeduction")
        }

        val nextRating = when {
            nextScore >= 75 -> "Excellent"
            nextScore >= 50 -> "Mediocre"
            else -> "Poor"
        }
        val nextColor = when {
            nextScore >= 75 -> "green"
            nextScore >= 50 -> "yellow"
            else -> "red"
        }
        result.put("score", nextScore)
        result.put("rating", nextRating)
        result.put("color", nextColor)
    }

    fun applyLocalWatchlistToData(ctx: Context, data: JSONObject?) = applyLocalWatchlistScoring(ctx, data)

    private fun resolveSubRetailerSlug(
        store: String,
        storeBucket: String = "",
        instacartRetailerSlug: String = ""
    ): String {
        if (instacartRetailerSlug.isNotBlank()) return instacartRetailerSlug.trim().lowercase()
        val bucket = storeBucket.trim().lowercase()
        if (bucket.contains(':')) {
            return bucket.substringAfter(':').trim()
        }
        val normStore = store.trim().lowercase()
        if (bucket.isNotBlank() && bucket != normStore) {
            return bucket
        }
        return ""
    }

    private fun normalizedCacheKey(
        ctx: Context,
        productTitle: String,
        rawIngredients: String?,
        store: String,
        storeBucket: String = "",
        instacartRetailerSlug: String = ""
    ): String {
        val wlSig = currentWatchlistSignature(ctx)
        val normTitle = productTitle.lowercase().replace(Regex("\\s+"), " ").trim()
        val normIng = rawIngredients?.trim().orEmpty()
        val normStore = store.trim().lowercase()
        val subSlug = resolveSubRetailerSlug(normStore, storeBucket, instacartRetailerSlug)
        val effectiveBucket = when {
            storeBucket.isNotBlank() -> storeBucket.trim().lowercase()
            subSlug.isNotBlank() -> "$normStore:$subSlug"
            else -> normStore
        }
        return "$normStore|$effectiveBucket|$subSlug|$normTitle|${normIng.hashCode()}|$wlSig"
    }

    /** Instant non-blocking lookup into the in-memory responseCache (<1ms). */
    fun peekCachedScan(
        ctx: Context,
        productTitle: String,
        rawIngredients: String?,
        store: String,
        storeBucket: String = "",
        instacartRetailerSlug: String = ""
    ): String? {
        if (productTitle.isBlank()) return null
        val key = normalizedCacheKey(ctx, productTitle, rawIngredients, store, storeBucket, instacartRetailerSlug)
        synchronized(responseCache) {
            responseCache[key]?.let { cached ->
                val isPoisoned = runCatching {
                    ScanHistoryStore.isPoisonedProduceEntry(productTitle, JSONObject(cached))
                }.getOrDefault(false)
                if (isPoisoned) {
                    responseCache.remove(key)
                    return null
                }
                return cached
            }
            if (rawIngredients.isNullOrBlank()) {
                return null
            }
            // If rawIngredients weren't cached yet, do NOT return a title-only entry so exact screen ingredients get scored
            return null
        }
    }

    /** Fire-and-forget background pre-warm triggered on product tap or visible aisle card detection. */
    fun prewarmScan(
        ctx: Context,
        productTitle: String,
        rawIngredients: String?,
        store: String,
        storeBucket: String = "",
        instacartRetailerSlug: String = ""
    ) {
        val clean = productTitle.trim()
        if (clean.length < 3) return
        val appCtx = ctx.applicationContext
        val key = normalizedCacheKey(appCtx, clean, rawIngredients, store, storeBucket, instacartRetailerSlug)
        synchronized(responseCache) {
            if (responseCache.containsKey(key)) return
        }
        if (!inFlightPrewarms.add(key)) return
        prewarmExecutor.execute {
            try {
                scan(appCtx, clean, rawIngredients, store, storeBucket, instacartRetailerSlug, skipAnalytics = true)
            } catch (_: Exception) {
                // ignore background prewarm failure
            } finally {
                inFlightPrewarms.remove(key)
            }
        }
    }

    /** Blocking call — run off the main thread. Returns the raw JSON response body. */
    fun scan(
        ctx: Context,
        productTitle: String,
        rawIngredients: String?,
        store: String,
        storeBucket: String = "",
        instacartRetailerSlug: String = "",
        barcode: String? = null,
        skipAnalytics: Boolean = false
    ): String {
        val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val seedOilsOn = isSeedOilsEnabled(ctx)
        val familyWatchlist = prefs.getStringSet("familyWatchlist", emptySet()).orEmpty()
            .map { if (it == "nitrites") "nitrates" else it }
            .filter { seedOilsOn || it != "seedOils" }
            .toSet()
        val dietaryWatchlist = prefs.getStringSet("dietaryWatchlist", emptySet()).orEmpty().toSet()
        val refCode = referredByCode(ctx)
        val normStore = store.trim().lowercase()
        val subSlug = resolveSubRetailerSlug(normStore, storeBucket, instacartRetailerSlug)
        val effectiveBucket = when {
            storeBucket.isNotBlank() -> storeBucket.trim().lowercase()
            subSlug.isNotBlank() -> "$normStore:$subSlug"
            else -> normStore
        }
        val explicitBarcodeDigits = barcode?.filter { it.isDigit() }?.takeIf { it.length in 8..14 }.orEmpty()
        val cacheTitle = if (explicitBarcodeDigits.isNotEmpty()) "$productTitle|upc:$explicitBarcodeDigits" else productTitle
        val normKey = normalizedCacheKey(ctx, cacheTitle, rawIngredients, store, storeBucket, instacartRetailerSlug)
        synchronized(responseCache) {
            responseCache[normKey]?.let { return it }
        }
        val effectiveRequestStore = when {
            normStore == "amazon" && subSlug == "wholefoods" -> "amazon"
            else -> store
        }
        val barcodeDigits = if (explicitBarcodeDigits.isNotEmpty()) {
            explicitBarcodeDigits
        } else {
            productTitle.trim().let { raw ->
                if (Regex("""^\d[\d\s-]{6,16}\d$""").matches(raw)) {
                    val digits = raw.filter { it.isDigit() }
                    if (digits.length in 8..14) digits else ""
                } else {
                    ""
                }
            }
        }
        val bodyJson = JSONObject().apply {
            put("productTitle", productTitle)
            if (barcodeDigits.isNotEmpty()) put("barcode", barcodeDigits)
            if (!rawIngredients.isNullOrBlank()) put("rawIngredients", rawIngredients)
            put("store", effectiveRequestStore)
            if (subSlug.isNotBlank() && (normStore == "instacart" || instacartRetailerSlug.isNotBlank())) {
                put("instacartRetailerSlug", subSlug)
            }
            put("surface", "android")
            if (isPreferStoreBrand(ctx)) {
                put("preferStoreBrand", true)
            }
            if (!seedOilsOn) {
                put("watchlist", JSONObject().put("seedOils", false))
            }
            if (familyWatchlist.isNotEmpty()) {
                put("familyWatchlist", JSONArray(familyWatchlist.toList().sorted()))
            }
            if (dietaryWatchlist.isNotEmpty()) {
                put("dietaryWatchlist", JSONArray(dietaryWatchlist.toList().sorted()))
            }
            put("deviceId", deviceId(ctx))
            put("deviceSecret", deviceSecret(ctx))
            if (!refCode.isNullOrBlank()) {
                put("referredByCode", refCode)
            }
            put("format", "json")
        }
        val bodyCacheKey = "$effectiveBucket|$subSlug|$bodyJson"

        synchronized(responseCache) {
            responseCache[bodyCacheKey]?.let { return it }
        }

        if (skipAnalytics) {
            bodyJson.put("skipAnalytics", true)
        }
        val body = bodyJson.toString()
        val pesticideWatchOn = "pesticide_risk" in dietaryWatchlist
        val reqWatchlistSig = "$seedOilsOn|${familyWatchlist.toList().sorted().joinToString(",")}|pest=${if (pesticideWatchOn) "1" else "0"}"
        val reqDietarySig = dietaryWatchlist.toList().sorted().joinToString(",")

        var lastErr = """{"ok":false,"error":"Unable to reach HeyBroc server"}"""
        for (endpoint in ENDPOINTS) {
            try {
                val http = postFollowingRedirectsDetailed(endpoint, body, maxRedirects = 4)
                val res = http.body
                if (http.statusCode == 429) {
                    return res
                }
                if (res.startsWith("{") && (res.contains("\"ok\":true") || res.contains("\"ok\":false") || res.contains("\"result\""))) {
                    if (res.contains("\"ok\":true")) {
                        val parsedObj = runCatching { JSONObject(res) }.getOrNull()
                        if (parsedObj != null) {
                            stampServerScanSnapshots(parsedObj, reqWatchlistSig, reqDietarySig)
                        }
                        val finalRes = parsedObj?.toString() ?: res
                        runCatching {
                            saveEntitlementSnapshot(ctx, parsedObj?.optJSONObject("entitlement"))
                        }
                        val swapLockedWithoutEntitlement = parsedObj?.optJSONObject("entitlement") == null &&
                            (parsedObj?.optJSONObject("swap")?.optBoolean("locked", false) == true)
                        if (!swapLockedWithoutEntitlement) {
                            synchronized(responseCache) {
                                responseCache[normKey] = finalRes
                                responseCache[bodyCacheKey] = finalRes
                            }
                        }
                        return finalRes
                    }
                    return res
                }
                lastErr = res
            } catch (e: Exception) {
                lastErr = JSONObject().put("ok", false).put("error", "${e.javaClass.simpleName}: ${e.message ?: "network error"}").toString()
            }
        }
        return lastErr
    }

    val ADVISORY_ALERT_IDS: Set<String> = setOf("pesticide_risk", "sugar_diabetes", "high_sodium")
    private val VALID_BATCH_ITEM_ID_RE = Regex(
        "^(?!^(?:__proto__|constructor|prototype)$)[A-Za-z0-9_-]{1,40}$",
        RegexOption.IGNORE_CASE
    )
    @Volatile
    private var batchRateLimitUntilMs: Long = 0L

    fun classifyAlertSeverity(alerts: List<DietaryAlert>): String {
        if (alerts.isEmpty()) return "none"
        return if (alerts.any { it.id !in ADVISORY_ALERT_IDS }) "allergen" else "advisory"
    }

    data class BatchScanRequestItem(
        val id: String,
        val productTitle: String,
        val barcode: String? = null
    )

    data class BatchBadgeResult(
        val id: String,
        val title: String,
        val score: Int,
        val rating: String,
        val color: String,
        val dietaryAlerts: List<DietaryAlert>,
        val alertSeverity: String,
        val isCategoryEstimate: Boolean,
        val isTransientLockedSwap: Boolean,
        val swapTitle: String?,
        val swapScore: Int,
        val fullJson: JSONObject,
        val rawJsonStr: String
    )

    data class BatchScanOutcome(
        val results: Map<String, BatchBadgeResult>,
        val transientFailure: Boolean,
        val retryAfterSec: Int? = null
    )

    private fun parseBatchBadgeResult(
        ctx: Context,
        id: String,
        fallbackTitle: String,
        itemJson: JSONObject
    ): BatchBadgeResult? {
        if (!itemJson.optBoolean("ok", false)) return null
        val working = JSONObject(itemJson.toString())
        applyLocalWatchlistScoring(ctx, working)
        val prod = working.optJSONObject("product")
        val res = working.optJSONObject("result") ?: return null
        if (!res.has("score") || res.isNull("score")) return null
        val score = res.optInt("score", 0).coerceIn(0, 100)
        val resolvedTitle = prod?.optString("title").orEmpty().trim().ifBlank { fallbackTitle.trim() }
        if (ScanHistoryStore.isPoisonedProduceEntry(resolvedTitle, working)) return null
        val rating = res.optString("rating").orEmpty().ifBlank {
            when {
                score >= 75 -> "Excellent"
                score >= 50 -> "Mediocre"
                else -> "Poor"
            }
        }
        val color = res.optString("color").orEmpty().ifBlank {
            when {
                score >= 75 -> "green"
                score >= 50 -> "yellow"
                else -> "red"
            }
        }
        val alerts = evaluateDietaryAlerts(ctx, prod, res, working)
        val severity = classifyAlertSeverity(alerts)
        val isCategoryEstimate = working.optBoolean("isCategoryEstimate", false)
        val swapObj = working.optJSONObject("swap")
        val isTransientLockedSwap = working.optJSONObject("entitlement") == null &&
            (swapObj?.optBoolean("locked", false) == true)
        val swapTitle = swapObj?.optString("title")?.trim()?.takeIf { it.isNotBlank() }
        val swapScore = swapObj?.optInt("score", 0) ?: 0
        return BatchBadgeResult(
            id = id,
            title = resolvedTitle,
            score = score,
            rating = rating,
            color = color,
            dietaryAlerts = alerts,
            alertSeverity = severity,
            isCategoryEstimate = isCategoryEstimate,
            isTransientLockedSwap = isTransientLockedSwap,
            swapTitle = swapTitle,
            swapScore = swapScore,
            fullJson = working,
            rawJsonStr = working.toString()
        )
    }

    /**
     * Blocking call — scores up to 12 visible store cards in a single HTTP round-trip via POST /api/scan
     * (`runBatchScan`, which sets `skipAnalytics: true` so passive scrolling never burns swap quota or rate limits)
     * and hydrates `responseCache` so tapping any scored item opens instantaneously.
     */
    fun scanBatchOutcome(
        ctx: Context,
        items: List<BatchScanRequestItem>,
        store: String,
        storeBucket: String = "",
        instacartRetailerSlug: String = ""
    ): BatchScanOutcome {
        if (items.isEmpty()) return BatchScanOutcome(emptyMap(), transientFailure = false)
        val out = LinkedHashMap<String, BatchBadgeResult>()
        val uncached = ArrayList<BatchScanRequestItem>()

        val uncachedBySig = LinkedHashMap<String, BatchScanRequestItem>()
        val duplicateIdsByPrimaryId = HashMap<String, MutableList<String>>()

        for (item in items.take(12)) {
            val cleanId = item.id.trim()
            if (!VALID_BATCH_ITEM_ID_RE.matches(cleanId)) continue
            val cleanTitle = item.productTitle.trim().take(300)
            val cleanBarcode = item.barcode?.filter { it.isDigit() }?.takeIf { it.length in 8..14 }.orEmpty()
            if (cleanTitle.isEmpty() && cleanBarcode.isEmpty()) continue
            val cacheLookupTitle = if (cleanBarcode.isNotEmpty()) "$cleanTitle|upc:$cleanBarcode" else cleanTitle
            if (cacheLookupTitle.isNotEmpty()) {
                val cachedStr = peekCachedScan(ctx, cacheLookupTitle, null, store, storeBucket, instacartRetailerSlug)
                    ?: if (cleanBarcode.isNotEmpty() && cleanTitle.isNotEmpty()) {
                        peekCachedScan(ctx, cleanTitle, null, store, storeBucket, instacartRetailerSlug)
                    } else null
                if (cachedStr != null && cachedStr.contains("\"ok\":true")) {
                    val parsed = runCatching {
                        parseBatchBadgeResult(ctx, cleanId, cleanTitle, JSONObject(cachedStr))
                    }.getOrNull()
                    if (parsed != null) {
                        out[cleanId] = parsed
                        continue
                    }
                }
            }
            val batchDedupeSig = "${cleanTitle.lowercase()}|$cleanBarcode"
            val existingPrimary = uncachedBySig[batchDedupeSig]
            if (existingPrimary != null) {
                duplicateIdsByPrimaryId.getOrPut(existingPrimary.id) { ArrayList() }.add(cleanId)
            } else {
                val reqItem = BatchScanRequestItem(cleanId, cleanTitle, cleanBarcode.ifEmpty { null })
                uncachedBySig[batchDedupeSig] = reqItem
                uncached.add(reqItem)
            }
        }

        if (uncached.isEmpty()) return BatchScanOutcome(out, transientFailure = false)

        val nowMs = System.currentTimeMillis()
        if (nowMs < batchRateLimitUntilMs) {
            val remSec = ((batchRateLimitUntilMs - nowMs + 999L) / 1000L).toInt().coerceAtLeast(1)
            return BatchScanOutcome(out, transientFailure = true, retryAfterSec = remSec)
        }

        val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val seedOilsOn = isSeedOilsEnabled(ctx)
        val familyWatchlist = prefs.getStringSet("familyWatchlist", emptySet()).orEmpty()
            .map { if (it == "nitrites") "nitrates" else it }
            .filter { seedOilsOn || it != "seedOils" }
            .toSet()
        val dietaryWatchlist = prefs.getStringSet("dietaryWatchlist", emptySet()).orEmpty().toSet()
        val pesticideWatchOn = "pesticide_risk" in dietaryWatchlist
        val reqWatchlistSig = "$seedOilsOn|${familyWatchlist.toList().sorted().joinToString(",")}|pest=${if (pesticideWatchOn) "1" else "0"}"
        val reqDietarySig = dietaryWatchlist.toList().sorted().joinToString(",")
        val refCode = referredByCode(ctx)
        val normStore = store.trim().lowercase()
        val subSlug = resolveSubRetailerSlug(normStore, storeBucket, instacartRetailerSlug)
        val effectiveRequestStore = when {
            normStore == "amazon" && subSlug == "wholefoods" -> "amazon"
            else -> store
        }

        val reqItemsArr = JSONArray()
        for (u in uncached) {
            reqItemsArr.put(JSONObject().apply {
                put("id", u.id)
                if (u.productTitle.isNotEmpty()) put("productTitle", u.productTitle)
                if (!u.barcode.isNullOrBlank()) put("barcode", u.barcode)
            })
        }

        val body = JSONObject().apply {
            put("items", reqItemsArr)
            put("store", effectiveRequestStore)
            if (subSlug.isNotBlank() && (normStore == "instacart" || instacartRetailerSlug.isNotBlank())) {
                put("instacartRetailerSlug", subSlug)
            }
            put("surface", "android")
            if (isPreferStoreBrand(ctx)) {
                put("preferStoreBrand", true)
            }
            if (!seedOilsOn) {
                put("watchlist", JSONObject().put("seedOils", false))
            }
            if (familyWatchlist.isNotEmpty()) {
                put("familyWatchlist", JSONArray(familyWatchlist.toList().sorted()))
            }
            if (dietaryWatchlist.isNotEmpty()) {
                put("dietaryWatchlist", JSONArray(dietaryWatchlist.toList().sorted()))
            }
            put("deviceId", deviceId(ctx))
            put("deviceSecret", deviceSecret(ctx))
            if (!refCode.isNullOrBlank()) {
                put("referredByCode", refCode)
            }
            put("format", "json")
        }.toString()

        var reachedServer = false
        var hadTransientStatus = false
        var lastRetryAfterSec: Int? = null
        for (endpoint in ENDPOINTS) {
            try {
                val http = postFollowingRedirectsDetailed(endpoint, body, maxRedirects = 4, readTimeoutMs = 10000)
                if (http.statusCode == 429) {
                    val waitSec = http.retryAfterSec ?: 15
                    lastRetryAfterSec = waitSec
                    batchRateLimitUntilMs = System.currentTimeMillis() + waitSec * 1000L
                    reachedServer = true
                    hadTransientStatus = true
                    break
                }
                if (http.statusCode >= 500) {
                    hadTransientStatus = true
                    continue
                }
                val res = http.body
                if (!res.startsWith("{")) continue
                val root = JSONObject(res)
                if (root.has("ok") && !root.optBoolean("ok", true)) {
                    reachedServer = true
                    if (http.statusCode == 408 || http.statusCode == 425) {
                        hadTransientStatus = true
                    }
                    break
                }
                val resultsObj = root.optJSONObject("results") ?: root.optJSONObject("batch") ?: continue
                reachedServer = true
                hadTransientStatus = false
                var savedEntitlement = false
                for (u in uncached) {
                    val itemJson = resultsObj.optJSONObject(u.id) ?: continue
                    if (!savedEntitlement && itemJson.optJSONObject("entitlement") != null) {
                        runCatching { saveEntitlementSnapshot(ctx, itemJson.optJSONObject("entitlement")) }
                        savedEntitlement = true
                    }
                    if (itemJson.optBoolean("ok", false)) {
                        stampServerScanSnapshots(itemJson, reqWatchlistSig, reqDietarySig)
                        val isEstimate = itemJson.optBoolean("isCategoryEstimate", false)
                        val swapLockedWithoutEntitlement = itemJson.optJSONObject("entitlement") == null &&
                            (itemJson.optJSONObject("swap")?.optBoolean("locked", false) == true)
                        val cacheTitle = if (!u.barcode.isNullOrBlank()) "${u.productTitle}|upc:${u.barcode}" else u.productTitle
                        if (!isEstimate && !swapLockedWithoutEntitlement && cacheTitle.isNotBlank()) {
                            val rawItemStr = itemJson.toString()
                            val normKey = normalizedCacheKey(ctx, cacheTitle, null, store, storeBucket, instacartRetailerSlug)
                            val plainTitleKey = if (!u.barcode.isNullOrBlank() && u.productTitle.isNotBlank()) {
                                normalizedCacheKey(ctx, u.productTitle, null, store, storeBucket, instacartRetailerSlug)
                            } else null
                            synchronized(responseCache) {
                                responseCache[normKey] = rawItemStr
                                if (plainTitleKey != null) {
                                    responseCache[plainTitleKey] = rawItemStr
                                }
                            }
                        }
                        val parsed = runCatching {
                            parseBatchBadgeResult(ctx, u.id, u.productTitle, itemJson)
                        }.getOrNull()
                        if (parsed != null) {
                            out[u.id] = parsed
                            duplicateIdsByPrimaryId[u.id]?.forEach { dupId ->
                                out[dupId] = parsed.copy(id = dupId, fullJson = JSONObject(parsed.rawJsonStr))
                            }
                        }
                    }
                }
                break
            } catch (_: Exception) {
                // try next endpoint
            }
        }

        return BatchScanOutcome(out, transientFailure = !reachedServer || hadTransientStatus, retryAfterSec = lastRetryAfterSec)
    }

    fun scanBatch(
        ctx: Context,
        items: List<BatchScanRequestItem>,
        store: String,
        storeBucket: String = "",
        instacartRetailerSlug: String = ""
    ): Map<String, BatchBadgeResult> =
        scanBatchOutcome(ctx, items, store, storeBucket, instacartRetailerSlug).results

    /** Blocking call — posts raw order / receipt / grocery-list text to POST /api/audit. */
    fun auditOrder(
        ctx: Context,
        rawOrderText: String,
        storeOverride: String? = null,
        preferStoreBrandOverride: Boolean? = null
    ): JSONObject {
        val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val seedOilsOn = isSeedOilsEnabled(ctx)
        val familyWatchlist = prefs.getStringSet("familyWatchlist", emptySet()).orEmpty()
            .map { if (it == "nitrites") "nitrates" else it }
            .filter { seedOilsOn || it != "seedOils" }
            .toSet()
        val dietaryWatchlist = prefs.getStringSet("dietaryWatchlist", emptySet()).orEmpty().toSet()
        val preferSb = preferStoreBrandOverride ?: isPreferStoreBrand(ctx)
        val secret = deviceSecret(ctx)
        val body = JSONObject().apply {
            put("rawOrderText", rawOrderText)
            if (!storeOverride.isNullOrBlank()) put("store", storeOverride)
            put("preferStoreBrand", preferSb)
            put("surface", "android")
            if (!seedOilsOn) {
                put("watchlist", JSONObject().put("seedOils", false))
            }
            if (familyWatchlist.isNotEmpty()) {
                put("familyWatchlist", JSONArray(familyWatchlist.toList().sorted()))
            }
            if (dietaryWatchlist.isNotEmpty()) {
                put("dietaryWatchlist", JSONArray(dietaryWatchlist.toList().sorted()))
            }
            put("deviceId", deviceId(ctx))
            put("deviceSecret", secret)
        }.toString()

        var lastErr = JSONObject().put("ok", false).put("error", "Unable to reach HeyBroc audit server")
        for (endpoint in AUDIT_ENDPOINTS) {
            try {
                val http = postFollowingRedirectsDetailed(
                    endpoint,
                    body,
                    maxRedirects = 4,
                    extraHeaders = mapOf("X-Device-Secret" to secret),
                    readTimeoutMs = 18000
                )
                val res = http.body
                if (http.statusCode == 429 && res.startsWith("{")) {
                    return JSONObject(res)
                }
                if (res.startsWith("{")) {
                    val json = JSONObject(res)
                    if (json.has("ok")) return json
                }
            } catch (e: Exception) {
                lastErr = JSONObject().put("ok", false).put("error", e.message ?: "Network error")
            }
        }
        return lastErr
    }

    private data class HttpPostResponse(
        val statusCode: Int,
        val body: String,
        val retryAfterSec: Int? = null
    )

    internal fun postFollowingRedirects(
        urlStr: String,
        jsonBody: String,
        maxRedirects: Int,
        extraHeaders: Map<String, String> = emptyMap(),
        readTimeoutMs: Int = 8000
    ): String = postFollowingRedirectsDetailed(
        urlStr = urlStr,
        jsonBody = jsonBody,
        maxRedirects = maxRedirects,
        extraHeaders = extraHeaders,
        readTimeoutMs = readTimeoutMs
    ).body

    private fun postFollowingRedirectsDetailed(
        urlStr: String,
        jsonBody: String,
        maxRedirects: Int,
        extraHeaders: Map<String, String> = emptyMap(),
        readTimeoutMs: Int = 8000
    ): HttpPostResponse {
        var currentUrl = urlStr
        var remaining = maxRedirects
        while (true) {
            val parsed = URL(currentUrl)
            require(parsed.protocol.equals("https", ignoreCase = true) && parsed.host.lowercase() in TRUSTED_HOSTS) {
                "Untrusted scan endpoint host: ${parsed.host}"
            }
            val conn = (parsed.openConnection() as HttpURLConnection).apply {
                instanceFollowRedirects = false
                requestMethod = "POST"
                connectTimeout = 5000
                readTimeout = readTimeoutMs
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("Accept", "application/json")
                for ((k, v) in extraHeaders) {
                    setRequestProperty(k, v)
                }
            }
            try {
                conn.outputStream.use { it.write(jsonBody.toByteArray(Charsets.UTF_8)) }
                val code = conn.responseCode
                if (code in listOf(301, 302, 303, 307, 308) && remaining > 0) {
                    val loc = conn.getHeaderField("Location")
                    if (!loc.isNullOrBlank()) {
                        val nextUrl = URL(parsed, loc)
                        require(nextUrl.protocol.equals("https", ignoreCase = true) && nextUrl.host.lowercase() in TRUSTED_HOSTS) {
                            "Refusing redirect to untrusted host: ${nextUrl.host}"
                        }
                        currentUrl = nextUrl.toString()
                        remaining--
                        continue
                    }
                }
                val retryAfterSec = conn.getHeaderField("Retry-After")
                    ?.trim()
                    ?.toIntOrNull()
                    ?.coerceIn(1, 300)
                val stream = if (code in 200..299) conn.inputStream else conn.errorStream
                val text = stream?.bufferedReader()?.use(BufferedReader::readText)?.trim().orEmpty()
                val resolvedBody = if (text.isNotEmpty()) {
                    text
                } else {
                    """{"ok":false,"error":"HTTP $code from $currentUrl"}"""
                }
                return HttpPostResponse(statusCode = code, body = resolvedBody, retryAfterSec = retryAfterSec)
            } finally {
                conn.disconnect()
            }
        }
    }

    fun storeForPackage(pkg: String): String = when (pkg) {
        "com.walmart.android" -> "walmart"
        "com.instacart.client" -> "instacart"
        "com.target.ui" -> "target"
        "com.kroger.mobile" -> "kroger"
        "de.apptiv.business.android.aldi_us" -> "aldi"
        "com.dd.doordash" -> "doordash"
        "com.ubercab.eats" -> "ubereats"
        "com.amazon.mShop.android.shopping", "com.wholefoods.wholefoodsmarket" -> "amazon"
        "com.rfi.sams.android", "com.samsclub.app" -> "sams"
        "com.brandingbrand.reactnative.and.bjs", "com.bjs.mobile" -> "bjs"
        "com.costco.app.android" -> "costco"
        "com.shipt.groceries" -> "shipt"
        else -> "walmart"
    }

    data class LabelVerifyOutcome(
        val ok: Boolean,
        val verified: Boolean,
        val message: String,
        val report: JSONObject? = null
    )

    /** Calls /api/label-report and returns structured verification status without false ✓ claims. */
    fun autoVerifyLabelOutcome(
        productTitle: String,
        currentIngredients: String = "",
        store: String = "walmart",
        onResult: (LabelVerifyOutcome) -> Unit
    ) {
        val labelReportEndpoint = (customBase.takeIf { it.isNotBlank() } ?: "https://www.heybroc.com") + "/api/label-report"
        Thread {
            val outcome = try {
                val payload = JSONObject().apply {
                    put("productTitle", productTitle)
                    put("currentIngredients", currentIngredients)
                    put("issueType", "reformulated")
                    put("store", store)
                }.toString()
                val http = postFollowingRedirectsDetailed(
                    labelReportEndpoint,
                    payload,
                    maxRedirects = 4
                )
                val obj = runCatching { JSONObject(http.body) }.getOrNull()
                if (http.statusCode !in 200..299 || obj == null || !obj.optBoolean("ok", false)) {
                    val serverErr = obj?.optString("error")?.trim()?.takeIf { it.isNotBlank() }
                        ?.replace(Regex("^[✓✔⏳⚠\\s]+"), "")
                    LabelVerifyOutcome(
                        ok = false,
                        verified = false,
                        message = "⚠ ${serverErr ?: "Could not verify label right now — tap to retry."}",
                        report = obj?.optJSONObject("report")
                    )
                } else {
                    val rep = obj.optJSONObject("report")
                    val status = rep?.optString("status").orEmpty().trim()
                    val resolutionSource = rep?.optString("resolutionSource").orEmpty().trim()
                        .ifBlank { obj.optString("resolutionSource").trim() }
                    val verified = status == "auto_updated" ||
                        (status != "flagged_for_review" && resolutionSource in setOf("usda", "openfoodfacts"))
                    val rawSummary = rep?.optString("summary")?.trim().orEmpty()
                    val cleanSummary = rawSummary
                        .replace(Regex("^[✓✔⏳⚠\\s]+"), "")
                        .trim()
                        .ifBlank {
                            if (verified) {
                                "Cross-checked against USDA FoodData Central & Open Food Facts."
                            } else {
                                "Queued for manual label review."
                            }
                        }
                    val prefix = if (verified) "✓" else "⏳"
                    LabelVerifyOutcome(
                        ok = true,
                        verified = verified,
                        message = "$prefix $cleanSummary",
                        report = rep
                    )
                }
            } catch (_: Exception) {
                LabelVerifyOutcome(
                    ok = false,
                    verified = false,
                    message = "⚠ Network error checking USDA & Open Food Facts — tap to retry.",
                    report = null
                )
            }
            android.os.Handler(android.os.Looper.getMainLooper()).post {
                onResult(outcome)
            }
        }.start()
    }

    /** Calls /api/label-report to auto-verify a product label against USDA & Open Food Facts. */
    fun autoVerifyLabel(
        productTitle: String,
        currentIngredients: String = "",
        store: String = "walmart",
        onResult: (summary: String) -> Unit
    ) {
        autoVerifyLabelOutcome(productTitle, currentIngredients, store) { outcome ->
            onResult(outcome.message)
        }
    }

    /** Offline sample used by "Launch Test Overlay Pill" if the API isn't reachable. */
    const val SAMPLE_JSON = """
    {"ok":true,"product":{"title":"Berry Swirl Strawberry Lowfat Yogurt","ingredients":"Cultured Grade A Reduced Fat Milk, Sugar, High Fructose Corn Syrup, Modified Corn Starch, Natural Flavor, Potassium Sorbate, Red 40."},
     "result":{"score":28,"rating":"Poor","color":"red","flagged":[
       {"id":"red40","name":"Red 40","category":"dyes","risk":"high","penalty":35,"explanation":"A petroleum-derived dye linked to hyperactivity in sensitive children and requiring a warning label in the EU."},
       {"id":"hfcs","name":"High Fructose Corn Syrup","category":"hfcs","risk":"moderate","penalty":20,"explanation":"A highly refined industrial sweetener tied to fatty-liver and metabolic issues when consumed regularly."},
       {"id":"ksorbate","name":"Potassium Sorbate","category":"preservatives","risk":"low","penalty":10,"explanation":"A common mold inhibitor that is generally low risk but signals a highly shelf-stabilized product."}]},
     "swap":{"title":"Stonyfield Organic Whole Milk Plain Yogurt","score":90,
       "webUrl":"https://www.walmart.com/ip/10535275",
       "deepLink":"https://www.walmart.com/ip/10535275",
       "androidPackage":"com.walmart.android"}}
    """
}
