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

    fun upgradeUrl(ctx: Context): String {
        val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val id = URLEncoder.encode(deviceId(ctx), "UTF-8")
        val ref = referredByCode(ctx)?.let { "&code=${URLEncoder.encode(it, "UTF-8")}" }.orEmpty()
        val email = prefs.getString("auth_email", null)?.trim()?.takeIf { it.isNotBlank() }
            ?.let { "&email=${URLEncoder.encode(it, "UTF-8")}" }.orEmpty()
        return "https://heybroc.com/?upgrade=1&deviceId=$id$ref$email"
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

    fun saveReferredByCode(ctx: Context, rawCode: String): String {
        val clean = rawCode.trim().uppercase()
            .substringAfterLast("/R/")
            .substringAfterLast("REF=")
            .replace(Regex("[^A-Z0-9-]"), "")
        val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().putString("referredByCode", clean).apply()
        return clean
    }

    /** Blocking call — claims a friend's invite code on /api/referral. */
    fun claimReferral(ctx: Context, rawCode: String): String {
        val clean = saveReferredByCode(ctx, rawCode)
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

    private val BILLING_PORTAL_ENDPOINTS = listOfNotNull(
        customBase.takeIf { it.isNotBlank() }?.let { "$it/api/billing/portal" },
        "https://www.heybroc.com/api/billing/portal",
        "https://heybroc.com/api/billing/portal",
        "https://cleancart-teal.vercel.app/api/billing/portal",
    ).distinct()

    /** Blocking call — fetches a Stripe Billing Portal session URL for one-tap subscription cancellation/management. */
    fun billingPortalUrl(ctx: Context): String? {
        val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val email = prefs.getString("auth_email", null)?.trim()
        val authToken = prefs.getString("auth_token", null)?.trim()
        val body = JSONObject().apply {
            put("deviceId", deviceId(ctx))
            put("deviceSecret", deviceSecret(ctx))
            if (!email.isNullOrBlank()) put("email", email)
        }.toString()
        val headers = mutableMapOf("X-Device-Secret" to deviceSecret(ctx))
        if (!authToken.isNullOrBlank()) {
            headers["Authorization"] = "Bearer $authToken"
        }
        for (endpoint in BILLING_PORTAL_ENDPOINTS) {
            try {
                val res = postFollowingRedirects(
                    endpoint,
                    body,
                    maxRedirects = 4,
                    extraHeaders = headers
                )
                if (res.startsWith("{")) {
                    val json = JSONObject(res)
                    val url = json.optString("url").trim()
                    if (url.startsWith("https://")) return url
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
    fun evaluateDietaryAlerts(
        ctx: Context,
        productJson: JSONObject?,
        resultJson: JSONObject? = null,
        rootDataJson: JSONObject? = null,
    ): List<DietaryAlert> {
        val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val selected = prefs.getStringSet("dietaryWatchlist", emptySet()).orEmpty()
        if (selected.isEmpty()) return emptyList()

        val title = productJson?.optString("title").orEmpty()
        val ingredients = productJson?.optString("ingredients").orEmpty()
        val nutrition = productJson?.optJSONObject("nutrition")
        val combined = "$title $ingredients"
        if (combined.isBlank()) {
            // Fall back to server-computed dietaryAlerts if product JSON has no local ingredients
            val serverArr = rootDataJson?.optJSONArray("dietaryAlerts")
            if (serverArr != null && serverArr.length() > 0) {
                val list = ArrayList<DietaryAlert>()
                for (i in 0 until serverArr.length()) {
                    val o = serverArr.optJSONObject(i) ?: continue
                    val id = o.optString("id")
                    if (id in selected) {
                        list.add(
                            DietaryAlert(
                                id = id,
                                label = o.optString("label", "⚠️ Dietary Alert"),
                                shortBadge = o.optString("shortBadge", "ALERT"),
                                reason = o.optString("reason", "Flagged by your personal watchlist")
                            )
                        )
                    }
                }
                return list
            }
            return emptyList()
        }

        val alerts = ArrayList<DietaryAlert>()

        if ("sugar_diabetes" in selected &&
            !Regex("\\b(zero\\s+sugar|sugar[\\s-]*free|unsweetened|\\bdiet\\b)\\b", RegexOption.IGNORE_CASE).containsMatchIn(title)
        ) {
            val sugarsG = nutrition?.optDouble("sugarsG100g", 0.0) ?: 0.0
            val sugarMatch = Regex(
                "\\b(high\\s+fructose\\s+corn\\s+syrup|corn\\s+syrup|cane\\s+sugar|brown\\s+sugar|sugar|sucrose|dextrose|maltose|fructose|glucose\\s+syrup|honey|maple\\s+syrup|molasses|agave|invert\\s+sugar|fruit\\s+juice\\s+concentrate)\\b",
                RegexOption.IGNORE_CASE
            ).find(ingredients)
            val refinedCarbMatch = Regex(
                "\\b(enriched\\s+(?:wheat\\s+)?flour|bleached\\s+(?:wheat\\s+)?flour|maltodextrin|modified\\s+(?:corn|food)\\s+starch|instant\\s+mashed|white\\s+rice\\s+flour)\\b",
                RegexOption.IGNORE_CASE
            ).find(ingredients)
            if (sugarsG >= 10.0 || sugarMatch != null || refinedCarbMatch != null) {
                val reasons = ArrayList<String>()
                if (sugarsG >= 10.0) reasons.add("${sugarsG.toInt()}g sugar/100g")
                if (sugarMatch != null) {
                    reasons.add("Added sweetener (${sugarMatch.value.lowercase()})")
                } else if (refinedCarbMatch != null) {
                    reasons.add("Refined glycemic starch (${refinedCarbMatch.value.lowercase()})")
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

        if ("dairy" in selected &&
            !Regex("\\b(dairy[\\s-]*free|non[\\s-]*dairy|plant[\\s-]*based|vegan)\\b", RegexOption.IGNORE_CASE).containsMatchIn(title)
        ) {
            val cleanedDairyText = combined.replace(
                Regex("\\b(coconut\\s+milk|almond\\s+milk|oat\\s+milk|soy\\s+milk|rice\\s+milk|cashew\\s+milk|peanut\\s+butter|cocoa\\s+butter|shea\\s+butter|apple\\s+butter|almond\\s+butter|cashew\\s+butter|sunflower\\s+butter|cream\\s+of\\s+tartar)\\b", RegexOption.IGNORE_CASE),
                " "
            )
            val m = Regex(
                "\\b(milk|cream|butter|buttermilk|whey|casein|caseinate|lactose|cheese|cheddar|mozzarella|parmesan|provolone|gouda|swiss|ricotta|yogurt|ghee|sour\\s+cream|half\\s+and\\s+half|lactalbumin)\\b",
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

        if ("wheat_gluten" in selected &&
            !Regex("\\b(gluten[\\s-]*free|grain[\\s-]*free|celiac)\\b", RegexOption.IGNORE_CASE).containsMatchIn(title)
        ) {
            val m = Regex(
                "\\b(wheat|enriched\\s+flour|bleached\\s+flour|unbleached\\s+flour|durum|semolina|spelt|farro|kamut|bulgur|couscous|seitan|barley|malt|malted|rye|triticale|graham\\s+flour|vital\\s+wheat\\s+gluten)\\b",
                RegexOption.IGNORE_CASE
            ).find(combined)
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

        if ("peanuts_nuts" in selected) {
            val m = Regex(
                "\\b(peanuts?|peanut\\s+butter|peanut\\s+oil|peanut\\s+flour|almonds?|cashews?|walnuts?|pecans?|hazelnuts?|filberts?|pistachios?|macadamia|brazil\\s+nuts?|pine\\s+nuts?|praline|marzipan|nougat|gianduja)\\b",
                RegexOption.IGNORE_CASE
            ).find(combined)
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
            val m = Regex(
                "\\b(soy|soya|soybeans?|soybean\\s+oil|soy\\s+lecithin|soy\\s+protein|soy\\s+flour|soy\\s+sauce|tamari|tofu|tempeh|edamame|miso|textured\\s+vegetable\\s+protein)\\b",
                RegexOption.IGNORE_CASE
            ).find(combined)
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

        if ("egg" in selected) {
            val cleanedEggText = combined.replace(Regex("\\beggplants?\\b", RegexOption.IGNORE_CASE), " ")
            val m = Regex(
                "\\b(eggs?|egg\\s+whites?|egg\\s+yolks?|dried\\s+egg|powdered\\s+egg|albumin|ovalbumin|ovomucoid|lysozyme|mayonnaise|aioli|meringue)\\b",
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

        if ("shellfish_fish" in selected) {
            val m = Regex(
                "\\b(shrimp|prawns?|crab|lobster|crawfish|crayfish|clams?|mussels?|oysters?|scallops?|calamari|squid|octopus|anchov(?:y|ies)|sardines?|salmon|tuna|cod|tilapia|halibut|haddock|trout|mahi|pollock|catfish|krill|fish\\s+sauce|fish\\s+oil)\\b",
                RegexOption.IGNORE_CASE
            ).find(combined)
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

        if ("high_sodium" in selected) {
            val sodiumMg = nutrition?.optDouble("sodiumMg100g", 0.0) ?: 0.0
            val sodiumAddMatch = Regex(
                "\\b(monosodium\\s+glutamate|sodium\\s+phosphate|disodium\\s+inosinate|disodium\\s+guanylate|sodium\\s+tripolyphosphate|sodium\\s+nitrite|sodium\\s+nitrate|sodium\\s+benzoate|sodium\\s+caseinate|brine|saline\\s+solution)\\b",
                RegexOption.IGNORE_CASE
            ).find(ingredients)
            if (sodiumMg >= 400.0 || sodiumAddMatch != null) {
                val reasons = ArrayList<String>()
                if (sodiumMg >= 400.0) reasons.add("${sodiumMg.toInt()}mg sodium/100g")
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

        return alerts
    }

    private const val KEY_SEED_OILS_ENABLED = "seed_oils_enabled_v1"

    fun isSeedOilsEnabled(ctx: Context): Boolean {
        val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return prefs.getBoolean(KEY_SEED_OILS_ENABLED, true)
    }

    fun setSeedOilsEnabled(ctx: Context, enabled: Boolean) {
        val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().putBoolean(KEY_SEED_OILS_ENABLED, enabled).apply()
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
        return "$fw|$dw|so=$so"
    }

    private fun resolveAdditiveCategory(item: JSONObject): String {
        val explicit = item.optString("category")
        if (explicit.isNotBlank()) return explicit
        val id = item.optString("id").lowercase()
        val name = item.optString("name").lowercase()
        return when {
            id in setOf("red40", "yellow5", "yellow6", "blue1", "blue2", "green3", "caramel_color", "caramelcolor", "tio2") -> "dyes"
            id in setOf("hfcs", "corn_syrup", "cornsyrup") -> "hfcs"
            id in setOf("soybean_oil", "soybeanoil", "canola_oil", "canolaoil", "corn_oil", "cornoil", "cottonseed_oil", "cottonseedoil", "sunflower_oil", "sunfloweroil", "safflower_oil", "saffloweroil", "grapeseed_oil", "grapeseedoil", "rice_bran_oil", "ricebranoil", "vegetable_oil", "vegoil", "phoil", "hydrogoil") ||
                Regex("\\b(soybean|canola|rapeseed|corn|cottonseed|sunflower|safflower|grapeseed|rice\\s*bran|vegetable|hydrogenated)\\s+oil\\b").containsMatchIn(name) -> "seedOils"
            id in setOf("bha", "bht", "tbhq", "sodium_benzoate", "nabenzoate", "potassium_sorbate", "ksorbate", "calcium_propionate", "capropionate", "potassium_bromate", "propylparaben", "edta") -> "preservatives"
            id in setOf("sodium_nitrite", "sodium_nitrate", "celerynitrate") -> "nitrates"
            id in setOf("sucralose", "aspartame", "ace_k", "acek", "saccharin", "neotame", "advantame") -> "sweeteners"
            id in setOf("polysorbate_80", "polysorbate80", "polysorbate_60", "polysorbate60", "carboxymethylcellulose", "cmc", "mono_diglycerides", "monodiglycerides", "datem", "sodium_stearoyl_lactylate", "pgpr", "carrageenan") -> "emulsifiers"
            id in setOf("xanthan_gum", "xanthan", "guar_gum", "locust_bean_gum", "cellulose_gum", "gellan_gum", "soylecithin") -> "gums"
            id in setOf("msg", "artificial_flavor", "artificialflavor", "natural_flavor", "naturalflavor", "autolyzed_yeast", "disodium_inosinate", "disodium_guanylate") -> "flavors"
            else -> ""
        }
    }

    /**
     * Re-evaluates a scan JSONObject in-place against the user's current Seed Oil toggle and familyWatchlist (2x strictness)
     * so toggling checkboxes in the app immediately updates the active floating pill, My Scans, and drawer score.
     */
    fun applyLocalWatchlistToData(ctx: Context, data: JSONObject?) {
        val result = data?.optJSONObject("result") ?: return
        val currentFlagged = result.optJSONArray("flagged") ?: return
        val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val seedOilsOn = isSeedOilsEnabled(ctx)
        val familySet = prefs.getStringSet("familyWatchlist", emptySet()).orEmpty()
            .map { if (it == "nitrites") "nitrates" else it }
            .toSet()

        // Snapshot original flagged array & 1x baseline score on first pass so repeated toggles are 100% reversible
        val origFlaggedStr = if (result.has("_origFlaggedJson")) {
            result.optString("_origFlaggedJson", "[]")
        } else {
            val snap = currentFlagged.toString()
            result.put("_origFlaggedJson", snap)
            snap
        }
        val origFlagged = runCatching { JSONArray(origFlaggedStr) }.getOrDefault(currentFlagged)

        val baseScore1x = if (result.has("_baseScore1x")) {
            result.optInt("_baseScore1x", result.optInt("score", 50))
        } else {
            var initial2xDeduction = 0
            for (i in 0 until origFlagged.length()) {
                val item = origFlagged.optJSONObject(i) ?: continue
                val risk = item.optString("risk", "low")
                val pen = item.optInt("penalty", 10)
                val was2x = (risk == "high" && pen >= 60) || (risk == "moderate" && pen >= 35) || (risk == "low" && pen >= 18)
                if (was2x) {
                    initial2xDeduction += when (risk) {
                        "high" -> 12
                        "moderate" -> 10
                        else -> 6
                    }
                }
            }
            val recovered = (result.optInt("score", 50) + initial2xDeduction).coerceIn(0, 100)
            result.put("_baseScore1x", recovered)
            recovered
        }

        val yuka = result.optJSONObject("yukaBreakdown")
        if (yuka != null && !yuka.has("_origAdditiveScore")) {
            yuka.put("_origAdditiveScore", yuka.optInt("additiveScore", 30))
        }

        val activeFlagged = JSONArray()
        var strictnessDeduction = 0
        var hasHighOrMod2x = false
        var hadSeedOilRemoved = false
        var remainingBasePenaltySum = 0
        var remainingHighRisk = false

        for (i in 0 until origFlagged.length()) {
            val rawItem = origFlagged.optJSONObject(i) ?: continue
            val item = JSONObject(rawItem.toString())
            val risk = item.optString("risk", "low")
            val cat = resolveAdditiveCategory(item)
            if (cat == "seedOils" && !seedOilsOn) {
                hadSeedOilRemoved = true
                continue
            }
            val is2x = cat.isNotEmpty() && (cat in familySet || (cat == "nitrates" && "preservatives" in familySet))
            val basePen = when (risk) {
                "high" -> 35
                "moderate" -> 20
                else -> 10
            }
            val idStr = item.optString("id")
            if (!idStr.startsWith("nutri_")) {
                remainingBasePenaltySum += basePen
                if (risk == "high") remainingHighRisk = true
            }
            item.put("penalty", if (is2x) basePen * 2 else basePen)
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

        var effectiveBaseScore = baseScore1x
        if (!seedOilsOn && hadSeedOilRemoved) {
            if (yuka != null) {
                val nutriScore = yuka.optInt("nutritionScore", 36)
                val orgScore = yuka.optInt("organicScore", 0)
                val nonNutriCount = (0 until activeFlagged.length()).count { idx ->
                    !activeFlagged.optJSONObject(idx)?.optString("id").orEmpty().startsWith("nutri_")
                }
                val multiDed = (nonNutriCount - 1).coerceAtLeast(0) * 3
                val addDed = (Math.round(remainingBasePenaltySum * 0.45f) + multiDed).coerceAtMost(30)
                val newAddScore = if (remainingHighRisk) 0 else (30 - addDed).coerceAtLeast(0)
                yuka.put("additiveScore", newAddScore)
                yuka.put("highRiskCapped", remainingHighRisk)
                val pillarSum = (nutriScore + newAddScore + orgScore).coerceIn(0, 100)
                effectiveBaseScore = if (remainingHighRisk) pillarSum.coerceAtMost(49) else pillarSum
            } else {
                effectiveBaseScore = (baseScore1x + 26).coerceIn(0, 88)
            }
        } else if (yuka != null && yuka.has("_origAdditiveScore")) {
            yuka.put("additiveScore", yuka.optInt("_origAdditiveScore", yuka.optInt("additiveScore", 30)))
        }

        var nextScore = (effectiveBaseScore - strictnessDeduction).coerceIn(0, 100)
        if (hasHighOrMod2x && nextScore > 39) {
            nextScore = 39
        }
        val nextRating = when {
            nextScore >= 75 -> "Excellent"
            nextScore >= 50 -> "Good"
            nextScore >= 25 -> "Poor"
            else -> "Bad"
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

    private fun normalizedCacheKey(ctx: Context, productTitle: String, rawIngredients: String?, store: String): String {
        val wlSig = currentWatchlistSignature(ctx)
        val normTitle = productTitle.lowercase().replace(Regex("\\s+"), " ").trim()
        val normIng = rawIngredients?.trim().orEmpty()
        return "${store.lowercase()}|$normTitle|${normIng.hashCode()}|$wlSig"
    }

    /** Instant non-blocking lookup into the in-memory responseCache (<1ms). */
    fun peekCachedScan(ctx: Context, productTitle: String, rawIngredients: String?, store: String): String? {
        if (productTitle.isBlank()) return null
        val key = normalizedCacheKey(ctx, productTitle, rawIngredients, store)
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
    fun prewarmScan(ctx: Context, productTitle: String, rawIngredients: String?, store: String) {
        val clean = productTitle.trim()
        if (clean.length < 3) return
        val appCtx = ctx.applicationContext
        val key = normalizedCacheKey(appCtx, clean, rawIngredients, store)
        synchronized(responseCache) {
            if (responseCache.containsKey(key)) return
        }
        if (!inFlightPrewarms.add(key)) return
        prewarmExecutor.execute {
            try {
                scan(appCtx, clean, rawIngredients, store)
            } catch (_: Exception) {
                // ignore background prewarm failure
            } finally {
                inFlightPrewarms.remove(key)
            }
        }
    }

    /** Blocking call — run off the main thread. Returns the raw JSON response body. */
    fun scan(ctx: Context, productTitle: String, rawIngredients: String?, store: String): String {
        val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val seedOilsOn = isSeedOilsEnabled(ctx)
        val familyWatchlist = prefs.getStringSet("familyWatchlist", emptySet()).orEmpty()
            .map { if (it == "nitrites") "nitrates" else it }
            .filter { seedOilsOn || it != "seedOils" }
            .toSet()
        val dietaryWatchlist = prefs.getStringSet("dietaryWatchlist", emptySet()).orEmpty().toSet()
        val refCode = referredByCode(ctx)
        val normKey = normalizedCacheKey(ctx, productTitle, rawIngredients, store)
        synchronized(responseCache) {
            responseCache[normKey]?.let { return it }
        }
        val body = JSONObject().apply {
            put("productTitle", productTitle)
            if (!rawIngredients.isNullOrBlank()) put("rawIngredients", rawIngredients)
            put("store", store)
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
            put("deviceSecret", deviceSecret(ctx))
            if (!refCode.isNullOrBlank()) {
                put("referredByCode", refCode)
            }
            put("format", "json")
        }.toString()

        synchronized(responseCache) {
            responseCache[body]?.let { return it }
        }

        var lastErr = """{"ok":false,"error":"Unable to reach HeyBroc server"}"""
        for (endpoint in ENDPOINTS) {
            try {
                val res = postFollowingRedirects(endpoint, body, maxRedirects = 4)
                if (res.startsWith("{") && (res.contains("\"ok\":true") || res.contains("\"ok\":false") || res.contains("\"result\""))) {
                    if (res.contains("\"ok\":true")) {
                        runCatching {
                            saveEntitlementSnapshot(ctx, JSONObject(res).optJSONObject("entitlement"))
                        }
                        synchronized(responseCache) {
                            responseCache[normKey] = res
                            responseCache[body] = res
                        }
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

    private fun postFollowingRedirects(
        urlStr: String,
        jsonBody: String,
        maxRedirects: Int,
        extraHeaders: Map<String, String> = emptyMap()
    ): String {
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
                readTimeout = 8000
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
                val stream = if (code in 200..299) conn.inputStream else conn.errorStream
                val text = stream?.bufferedReader()?.use(BufferedReader::readText)?.trim().orEmpty()
                if (text.isNotEmpty()) return text
                return """{"ok":false,"error":"HTTP $code from $currentUrl"}"""
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

    /** Offline sample used by "Launch Test Overlay Pill" if the API isn't reachable. */
    const val SAMPLE_JSON = """
    {"ok":true,"product":{"title":"Berry Swirl Strawberry Lowfat Yogurt","ingredients":"Cultured Grade A Reduced Fat Milk, Sugar, High Fructose Corn Syrup, Modified Corn Starch, Natural Flavor, Potassium Sorbate, Red 40."},
     "result":{"score":28,"rating":"Poor","color":"red","flagged":[
       {"id":"red40","name":"Red 40","category":"dyes","risk":"high","penalty":35,"explanation":"A petroleum-derived dye linked to hyperactivity in sensitive children and requiring a warning label in the EU."},
       {"id":"hfcs","name":"High Fructose Corn Syrup","category":"hfcs","risk":"moderate","penalty":20,"explanation":"A highly refined industrial sweetener tied to fatty-liver and metabolic issues when consumed regularly."},
       {"id":"ksorbate","name":"Potassium Sorbate","category":"preservatives","risk":"low","penalty":10,"explanation":"A common mold inhibitor that is generally low risk but signals a highly shelf-stabilized product."}]},
     "swap":{"title":"Stonyfield Organic Whole Milk Plain Yogurt","score":90,
       "webUrl":"https://www.walmart.com/search?q=Stonyfield%20Organic%20Whole%20Milk%20Plain%20Yogurt",
       "deepLink":"https://www.walmart.com/search?q=Stonyfield%20Organic%20Whole%20Milk%20Plain%20Yogurt",
       "androidPackage":"com.walmart.android"}}
    """
}
