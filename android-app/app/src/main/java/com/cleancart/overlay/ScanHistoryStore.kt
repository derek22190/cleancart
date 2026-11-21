package com.cleancart.overlay

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * Persists Yuka-style Scan History and Favorites on-device using the exact `/api/scan` JSON schema
 * (`{ ok, product: { title, brand, category, imageUrl, ingredients }, result: { score, rating, color, flagged, yukaBreakdown }, swap }`).
 */
object ScanHistoryStore {
    private const val PREFS = "heybroc_yuka_store_v1"
    private const val KEY_HISTORY = "scan_history_json"
    private const val KEY_FAVORITES = "favorites_json"
    private const val KEY_STREAK_DATES = "clean_cart_streak_dates_v1"
    private const val MAX_HISTORY = 80

    data class StreakStatus(
        val streakDays: Int,
        val windowNumbers: List<Pair<Int, Boolean>>,
        val cleanCount: Int
    )

    private fun epochDay(ms: Long = System.currentTimeMillis()): Long =
        java.util.concurrent.TimeUnit.MILLISECONDS.toDays(ms + java.util.TimeZone.getDefault().rawOffset)

    fun recordStreakActivity(context: Context, timestampMs: Long = System.currentTimeMillis()) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val day = epochDay(timestampMs)
        val existing = prefs.getStringSet(KEY_STREAK_DATES, emptySet()).orEmpty().toMutableSet()
        if (existing.add(day.toString())) {
            prefs.edit().putStringSet(KEY_STREAK_DATES, existing).apply()
        }
    }

    fun getStreakStatus(context: Context): StreakStatus {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val storedDays = prefs.getStringSet(KEY_STREAK_DATES, emptySet()).orEmpty()
            .mapNotNull { it.toLongOrNull() }
            .toMutableSet()

        val history = getHistory(context)
        val favs = getFavorites(context)
        (history + favs).forEach { item ->
            val ts = item.optLong("scannedAtMs", 0L).takeIf { it > 0L }
                ?: item.optLong("favoritedAtMs", 0L)
            if (ts > 0L) storedDays.add(epochDay(ts))
        }

        val today = epochDay()
        // Record today's visit so the shopper's active session always counts toward their daily Clean Cart Streak
        if (storedDays.add(today)) {
            prefs.edit().putStringSet(KEY_STREAK_DATES, storedDays.map { it.toString() }.toSet()).apply()
        }

        var streak = 0
        var cursor = today
        while (storedDays.contains(cursor)) {
            streak++
            cursor--
        }
        val effectiveStreak = streak.coerceAtLeast(1)

        // Build the 5-circle progress window matching Slide 5 (e.g. 1..5, or trailing 5 days up to effectiveStreak)
        val startNum = if (effectiveStreak <= 5) 1 else (effectiveStreak - 4)
        val window = (startNum until (startNum + 5)).map { dayNum ->
            dayNum to (dayNum <= effectiveStreak)
        }

        val cleanItemsCount = (history + favs).count { item ->
            val sc = item.optJSONObject("result")?.optInt("score") ?: item.optInt("score", 0)
            sc >= 75
        }

        return StreakStatus(
            streakDays = effectiveStreak,
            windowNumbers = window,
            cleanCount = cleanItemsCount
        )
    }

    private val PRESERVED_TITLE_ACRONYMS = setOf(
        "USDA", "FDA", "MSG", "BBQ", "USA", "GMO", "IPA", "UHT", "BPA",
        "MCT", "DHA", "EPA", "A2",
        "D3", "B12", "B6", "A1", "V8", "C4", "7UP", "XL", "XXL", "II", "III", "IV"
    )

    fun cleanDisplayTitle(raw: String): String {
        var s = raw.replace(Regex("\\s+"), " ").trim()
        if (s.isEmpty()) return s
        // Normalize jammed/capitalized unit suffixes (e.g. "86.4Oz" -> "86.4 oz")
        s = s.replace(Regex("(?i)\\b(\\d+(?:\\.\\d+)?)\\s*(fl\\.?\\s*oz|oz|ml|mg|mcg|g|kg|lbs?|ct|pk)\\b")) { m ->
            val num = m.groupValues[1]
            val rawUnit = m.groupValues[2].lowercase().replace(Regex("\\s+"), " ")
            val unit = if (rawUnit.startsWith("fl")) "fl oz" else rawUnit
            "$num $unit"
        }
        // Heal 2nd-letter shift-key typos ("OLd" -> "Old", "KEllogg" -> "Kellogg", "REal" -> "Real", "FAt" -> "Fat", "MIlk" -> "Milk")
        s = s.replace(Regex("\\b([A-Z])([A-Z])([a-z]{1,})\\b")) { m ->
            val full = m.value
            val stem = if (m.groupValues[3] == "s") "${m.groupValues[1]}${m.groupValues[2]}" else ""
            if (
                full in setOf("PBfit", "BJs", "RXBar", "McCafe") ||
                (stem.isNotEmpty() && (stem in PRESERVED_TITLE_ACRONYMS || stem in setOf("BJ", "TV", "ID", "CD", "DJ", "PJ", "PC", "UV")))
            ) {
                full
            } else {
                "${m.groupValues[1]}${m.groupValues[2].lowercase()}${m.groupValues[3]}"
            }
        }
        // Convert ALL-CAPS words ("PURIFIED WATER" -> "Purified Water") while keeping true acronyms ("USDA", "BBQ")
        s = s.replace(Regex("\\b([A-Z]{2,}(?:['’][A-Z]+)?)\\b")) { m ->
            val w = m.value
            val plain = w.replace("’", "'")
            if (plain in PRESERVED_TITLE_ACRONYMS) {
                w
            } else {
                w.take(1) + w.substring(1).lowercase()
            }
        }
        return s.replace(Regex("\\s+"), " ").trim()
    }

    fun extractTitle(item: JSONObject): String =
        cleanDisplayTitle(
            item.optJSONObject("product")?.optString("title").orEmpty()
                .ifBlank { item.optString("productTitle") }
                .trim()
        )

    fun canonicalKey(title: String): String {
        var s = title.lowercase()
            .replace(Regex("\\b\\d+(?:\\.\\d+)?\\s*(?:oz|fl\\s*oz|lb|lbs|g|kg|ml|l|ct|pk|pack)\\b"), " ")
            .replace(Regex("\\b(?:party\\s+size|family\\s+size|share\\s+size|snack\\s+size)\\b"), " ")
        if (s.contains("doritos") || s.contains("tostitos") || s.contains("siete")) {
            s = s.replace(Regex("\\b(?:flavored|tortilla\\s+chips|tortilla|chips)\\b"), " ")
        }
        return s.replace(Regex("[^a-z0-9]+"), " ").trim()
    }

    private fun normKey(title: String): String = canonicalKey(title)

    fun recordScan(context: Context, rawScanJson: JSONObject, storeKey: String = "walmart") {
        val title = extractTitle(rawScanJson)
        if (title.isBlank()) return
        val key = normKey(title)
        if (key.isBlank()) return

        val now = System.currentTimeMillis()
        val copy = JSONObject(rawScanJson.toString()).apply {
            remove("storeImageUrl")
            optJSONObject("product")?.remove("storeImageUrl")
            put("scannedAtMs", now)
            put("storeKey", storeKey)
        }

        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val existing = getHistory(context).filterNot { normKey(extractTitle(it)) == key }
        val updated = JSONArray().apply {
            put(copy)
            existing.take(MAX_HISTORY - 1).forEach { put(it) }
        }
        prefs.edit().putString(KEY_HISTORY, updated.toString()).apply()
        recordStreakActivity(context, now)
    }

    fun getHistory(context: Context): List<JSONObject> {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val raw = prefs.getString(KEY_HISTORY, null) ?: return emptyList()
        return parseList(raw).onEach { ScanApi.applyLocalWatchlistToData(context, it) }
    }

    fun clearHistory(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().remove(KEY_HISTORY).apply()
    }

    fun getFavorites(context: Context): List<JSONObject> {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val raw = prefs.getString(KEY_FAVORITES, null) ?: return emptyList()
        return parseList(raw).onEach { ScanApi.applyLocalWatchlistToData(context, it) }
    }

    fun getExploreCatalog(context: Context): List<JSONObject> {
        val now = System.currentTimeMillis()
        return EXPLORE_CATALOG.filter { item ->
            val lookupObj = item.optJSONObject("lookup")
            val verifiedIso = lookupObj?.optString("verifiedAt").orEmpty()
                .ifBlank { lookupObj?.optString("sourceUpdatedAt").orEmpty() }
            verifiedIso.isBlank() || isCatalogDateFresh(verifiedIso, now)
        }.onEach { ScanApi.applyLocalWatchlistToData(context, it) }
    }

    fun isFavorite(context: Context, title: String): Boolean {
        val key = normKey(title)
        if (key.isBlank()) return false
        return getFavorites(context).any { normKey(extractTitle(it)) == key }
    }

    /** Returns true if the item is now favorited, false if removed. */
    fun toggleFavorite(context: Context, itemJson: JSONObject): Boolean {
        val title = extractTitle(itemJson)
        val key = normKey(title)
        if (key.isBlank()) return false

        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val current = getFavorites(context)
        val already = current.any { normKey(extractTitle(it)) == key }
        val nextList = if (already) {
            current.filterNot { normKey(extractTitle(it)) == key }
        } else {
            listOf(JSONObject(itemJson.toString()).apply {
                remove("storeImageUrl")
                optJSONObject("product")?.remove("storeImageUrl")
                put("favoritedAtMs", System.currentTimeMillis())
            }) + current
        }
        val arr = JSONArray().apply { nextList.forEach { put(it) } }
        prefs.edit().putString(KEY_FAVORITES, arr.toString()).apply()
        return !already
    }

    /**
     * Automatically saves a Clean Swap recommendation into Favorites and Scan History
     * when the shopper taps "Find in [Store] ↗" or "Swap in [Store] ↗".
     */
    fun saveSwapToFavorites(
        context: Context,
        swap: JSONObject,
        replacedTitle: String = "",
        storeKey: String = "walmart"
    ) {
        val swapTitle = swap.optString("title").trim()
        val key = normKey(swapTitle)
        if (key.isBlank()) return

        val swapScore = swap.optInt("score", 95)
        val swapRating = when {
            swapScore >= 75 -> "Excellent"
            swapScore >= 50 -> "Mediocre"
            else -> "Poor"
        }
        val swapColor = when {
            swapScore >= 75 -> "green"
            swapScore >= 50 -> "yellow"
            else -> "red"
        }
        val swapBrand = swap.optString("brand").ifBlank { swapTitle.substringBefore(" ") }
        val swapIngredients = swap.optString("ingredients").trim()
        val isOrg = if (swap.optJSONObject("nutrition")?.has("isOrganic") == true) {
            swap.optJSONObject("nutrition")?.optBoolean("isOrganic", false) == true
        } else {
            swap.optBoolean("isOrganic", false)
        }
        val orgScore = if (isOrg) 10 else 0
        val addScore = if (swapScore >= 70) 30 else 15
        val nutScore = (swapScore - addScore - orgScore).coerceIn(0, 60)
        val now = System.currentTimeMillis()

        val itemJson = JSONObject().apply {
            put("ok", true)
            put("storeKey", storeKey)
            put("scannedAtMs", now)
            put("favoritedAtMs", now)
            put("product", JSONObject().apply {
                val swapBarcode = swap.optString("barcode").trim()
                val rawSwapImg = swap.optString("imageUrl").ifBlank { swap.optString("image") }
                val swapCatArt = normalizeCategoryArtUrl(swap.optString("categoryArtUrl"))
                put("title", swapTitle)
                put("brand", swapBrand)
                put("category", "Clean Swaps")
                if (swapBarcode.isNotEmpty()) put("barcode", swapBarcode)
                put("imageUrl", resolveBestImageUrl(swapTitle, rawSwapImg, swapBrand, swapBarcode))
                if (swapCatArt.isNotEmpty()) put("categoryArtUrl", swapCatArt)
                put("ingredients", swapIngredients)
                put("isOrganic", isOrg)
                put("nutrition", JSONObject().apply {
                    put("isOrganic", isOrg)
                })
                if (replacedTitle.isNotBlank()) {
                    put("description", "Clean 1-for-1 replacement for $replacedTitle")
                }
            })
            put("result", JSONObject().apply {
                put("score", swapScore)
                put("rating", swapRating)
                put("color", swapColor)
                put("flagged", JSONArray())
                put("yukaBreakdown", JSONObject().apply {
                    put("nutritionScore", nutScore)
                    put("nutriScoreGrade", if (nutScore >= 45) "A" else "B")
                    put("additiveScore", addScore)
                    put("organicScore", orgScore)
                })
            })
            put("storeSwapLink", JSONObject(swap.toString()))
        }

        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val currentFavs = getFavorites(context).filterNot { normKey(extractTitle(it)) == key }
        val nextFavs = listOf(itemJson) + currentFavs
        val favArr = JSONArray().apply { nextFavs.forEach { put(it) } }
        prefs.edit().putString(KEY_FAVORITES, favArr.toString()).apply()

        recordScan(context, itemJson, storeKey)
    }

    private const val MAX_ENTRY_AGE_MS = 90L * 24L * 60L * 60L * 1000L

    fun isEntryFresh(ts: Long, now: Long = System.currentTimeMillis()): Boolean {
        if (ts <= 0L) return false
        val ageMs = now - ts
        return ageMs in 0L..MAX_ENTRY_AGE_MS
    }

    fun isCatalogDateFresh(isoDate: String, now: Long = System.currentTimeMillis()): Boolean {
        val trimmed = isoDate.trim()
        if (trimmed.length < 10) return false
        return runCatching {
            val sdf = java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US).apply {
                timeZone = java.util.TimeZone.getTimeZone("UTC")
                isLenient = false
            }
            val parsedMs = sdf.parse(trimmed.substring(0, 10))?.time ?: return false
            val ageMs = now - parsedMs
            ageMs in (-24L * 60L * 60L * 1000L)..MAX_ENTRY_AGE_MS
        }.getOrDefault(false)
    }

    fun passesVariantGuard(query: String, candidateTitle: String): Boolean {
        val q = query.lowercase()
        val t = candidateTitle.lowercase()
        val rules = listOf(
            Regex("\\bunflavored\\b") to Regex("\\bunflavored\\b"),
            Regex("\\bextra\\s+creamy\\b") to Regex("\\bextra\\s+creamy\\b"),
            Regex("\\bfull\\s+fat\\b") to Regex("\\bfull\\s+fat\\b"),
            Regex("\\bcookies\\s*(?:&|and|'n)?\\s*cr[eè]me\\b|\\bcookies\\s*(?:&|and|'n)?\\s*cream\\b") to Regex("\\bcookies\\b"),
            Regex("\\bcool\\s+ranch\\b") to Regex("\\bcool\\s+ranch\\b"),
            Regex("\\bsimply\\s+nkd\\b|\\bnkd\\b") to Regex("\\bsimply\\s+nkd\\b|\\bnkd\\b"),
            Regex("\\bpro\\s+elite\\b|\\bcore\\s+power\\s+elite\\b|\\b42\\s*g\\b") to Regex("\\bpro\\s+elite\\b|\\belite\\b|\\b42\\s*g\\b"),
            Regex("\\b26\\s*g\\b") to Regex("\\b26\\s*g\\b"),
            Regex("\\bsome\\s+pulp\\b|\\blots\\s+of\\s+pulp\\b|\\bwith\\s+pulp\\b") to Regex("\\bsome\\s+pulp\\b|\\blots\\s+of\\s+pulp\\b|\\bwith\\s+pulp\\b"),
            Regex("\\bno\\s+pulp\\b|\\bpulp[\\s-]*free\\b") to Regex("\\bno\\s+pulp\\b|\\bpulp[\\s-]*free\\b"),
            Regex("\\bunsweetened\\b") to Regex("\\bunsweetened\\b|\\b0g\\s+sugar\\b"),
            Regex("\\bzero\\s+sugar\\b|\\bsugar[\\s-]*free\\b|\\bdiet\\b") to Regex("\\bzero\\b|\\bsugar[\\s-]*free\\b|\\bdiet\\b|\\bunsweetened\\b|\\blyte\\b|\\bultra\\b"),
            Regex("\\bdoubleshot\\b") to Regex("\\bdoubleshot\\b"),
            Regex("\\bmountain\\s+water\\b|\\bstill\\s+water\\b") to Regex("\\bmountain\\s+water\\b|\\bstill\\b|\\bspring\\s+water\\b|\\bartesian\\s+water\\b|\\bpurified\\s+water\\b"),
            Regex("\\bsoy\\s*milk\\b") to Regex("\\bsoy\\s*milk\\b"),
            Regex("\\boat\\s*milk\\b") to Regex("\\boat\\s*milk\\b"),
            Regex("\\balmond\\s*milk\\b") to Regex("\\balmond\\s*milk\\b|\\bmilked\\s+almonds\\b"),
            Regex("\\borganic\\b") to Regex("\\borganic\\b")
        )
        for ((qRe, tRe) in rules) {
            if (qRe.containsMatchIn(q) && !tRe.containsMatchIn(t)) return false
        }
        val reverseRules = listOf(
            Regex("\\bunflavored\\b") to Regex("\\bunflavored\\b"),
            Regex("\\bextra\\s+creamy\\b") to Regex("\\bextra\\s+creamy\\b"),
            Regex("\\bclassic\\s+vanilla\\b|\\bvanilla\\s+oatmilk\\b") to Regex("\\bvanilla\\b"),
            Regex("\\bcookies\\s*(?:&|and|'n)?\\s*cream\\b") to Regex("\\bcookies\\b"),
            Regex("\\bcool\\s+ranch\\b") to Regex("\\bcool\\s+ranch\\b"),
            Regex("\\bsimply\\s+nkd\\b") to Regex("\\bsimply\\s+nkd\\b|\\bnkd\\b"),
            Regex("\\bpro\\s+elite\\b|\\bcore\\s+power\\s+elite\\b") to Regex("\\bpro\\s+elite\\b|\\belite\\b|\\b42\\s*g\\b"),
            Regex("\\bdoubleshot\\b") to Regex("\\bdoubleshot\\b"),
            Regex("\\bliquid\\s+death\\s+mountain\\s+water\\b") to Regex("\\bmountain\\s+water\\b|\\bstill\\s+water\\b")
        )
        for ((tRe, qRe) in reverseRules) {
            if (tRe.containsMatchIn(t) && !qRe.containsMatchIn(q)) return false
        }
        return true
    }

    fun isPoisonedProduceEntry(rawTitle: String, item: JSONObject?): Boolean {
        val t = rawTitle.lowercase()
        val isPlainProduce = Regex("\\b(?:fresh\\s+whole|sweet\\s+potat(?:o|oes)|russet\\s+potat(?:o|oes)|idaho\\s+potat(?:o|oes)|yukon\\s+gold\\s+potat(?:o|oes)|red\\s+potat(?:o|oes)|yellow\\s+potat(?:o|oes))\\b").containsMatchIn(t) &&
            !Regex("\\b(?:chips?|crisps?|fries|fried|tots|puffs?|hash\\s*browns?|casserole|pie)\\b").containsMatchIn(t)
        if (!isPlainProduce) return false
        if (item == null) return false
        val prod = item.optJSONObject("product")
        val ing = prod?.optString("ingredients").orEmpty()
        val brand = prod?.optString("brand").orEmpty()
        val score = item.optJSONObject("result")?.optInt("score", 90) ?: item.optInt("score", 90)
        if (score < 75) return true
        if (Regex("\\b(?:bruce'?s|simply\\s+nature)\\b", RegexOption.IGNORE_CASE).containsMatchIn(brand) && !t.contains("simply nature") && !t.contains("bruce")) return true
        return Regex("\\b(?:canola|sunflower|safflower|soybean|vegetable|palm|corn)\\s+oil\\b", RegexOption.IGNORE_CASE).containsMatchIn(ing)
    }

    private val VERIFIED_OFF_IMAGES: List<Pair<Regex, String>> = listOf(
        Regex("^(?!.*\\b(?:packets?|mix|seasoning|plant|vegan|dairy[- ]?free|dip|spicy|bacon|pickle|avocado|fat[- ]?free)\\b).*\\bhidden\\s+valley\\b.*\\branch\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/007/110/000/3116/front_en.7.400.jpg",
        // Provenance: OFF 0863699000146 "Ranch Dressing & Marinade" (Primal Kitchen, US) — front photo visually verified 2026-11-19.
        Regex("^(?!.*\\b(?:spicy|greek|vegan|plant|dip|buffalo|jalape(?:n|ñ)o|chipotle|cilantro|garlic|truffle|bbq|caesar|sauce|seasoning|mix|packets?|pickle|cauliflower|chips)\\b).*\\bprimal\\s+kitchen\\b.*\\branch\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/086/369/900/0146/front_en.4.400.jpg",
        Regex("\\bprimal\\s+kitchen\\b.*\\b(?:mayo|mayonnaise)\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/066/369/002/4048/front_en.3.400.jpg",
        Regex("\\bprimal\\s+kitchen\\b.*\\bketchup\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/827/574/200/7125/front_en.8.400.jpg",
        Regex("\\bmarketside\\b(?!.*\\b(?:romaine|dip|artichoke|organic)\\b).*\\bbaby\\s+spinach\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/068/113/132/8982/front_en.3.400.jpg",
        Regex("^(?!.*\\b(?:churros?|rolls?|bars?|treats?|spread|coffee|creamer|milk|shake|bugles|pancakes?|waffles?|oatmeal|frosting|popcorn)\\b).*\\bcinnamon\\s+toast\\s+crunch\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/10167730/front_en.3.400.jpg",
        Regex("\\bkellogg'?s\\b.*\\bfrosted\\s+flakes\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/003/800/012/7502/front_en.3.400.jpg",
        Regex("\\bnature'?s\\s+path\\b.*\\bheritage\\s+flakes\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/991/360/277/0206/front_en.4.400.jpg",
        Regex("\\bcampbell'?s\\b.*\\bmanhattan\\b.*\\bclam\\s+chowder\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/005/100/000/5540/front_en.11.400.jpg",
        Regex("\\bcampbell'?s\\b.*\\bchunky\\b.*\\bnew\\s+england\\s+clam\\s+chowder\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/75395322/front_en.3.400.jpg",
        Regex("\\bamy'?s\\b.*\\blentil\\b.*\\bsoup\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/004/223/400/5833/front_en.3.400.jpg",
        Regex("^(?!.*\\b(?:simply|nkd|dinamita|3d|minis?|dip)\\b).*\\bdoritos\\b.*\\bnacho\\s+cheese\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/120/010/800/0721/front_en.3.400.jpg",
        Regex("^(?!.*\\b(?:simply|nkd|dinamita|3d|minis?|dip)\\b).*\\bdoritos\\b.*\\bcool\\s+ranch\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/000/284/000/9151/front_en.7.400.jpg",
        Regex("\\blay'?s\\b.*\\bwavy\\b.*\\boriginal\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/002/840/031/0468/front_en.13.400.jpg",
        Regex("\\bsiete\\b(?!.*\\b(?:nacho|ranch|lime|fuego|jalapeno|churro|cinnamon)\\b).*\\btortilla\\s+chips\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/085/176/900/7003/front_en.13.400.jpg",
        Regex("\\bsanta\\s+cruz\\b.*\\bpeanut\\s+butter\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/005/150/090/2882/front_en.28.400.jpg",
        Regex("\\bgood\\s*(?:&|and)?\\s*gather\\b.*\\bpeanut\\s+butter\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/008/523/934/0400/front_en.3.400.jpg",
        Regex("^(?!.*\\b(?:granola|bars?)\\b).*\\bthree\\s+wishes\\b.*\\bcocoa\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/086/000/215/2493/front_en.3.400.jpg",
        Regex("^(?!.*\\b(?:granola|bars?)\\b).*\\bthree\\s+wishes\\b.*\\bfrosted\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/085/001/681/3046/front_en.11.400.jpg",
        Regex("\\borganic\\s+valley\\b.*\\bamerican\\b.*\\bcheese\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/009/396/600/4861/front_en.5.400.jpg",
        Regex("\\borganic\\s+valley\\b.*\\bsharp\\s+cheddar\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/009/396/600/5431/front_en.5.400.jpg",
        Regex("\\borganic\\s+valley\\b(?!.*\\b(?:chocolate|2%|1%|skim|fat\\s*free|lowfat|eggnog|creamer|butter|cheese)\\b).*\\b(?:grassmilk|whole\\s+milk)\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/64715087/front_en.3.400.jpg",
        Regex("\\blactaid\\b(?!.*\\b(?:chocolate|2%|1%|skim|fat[- ]?free|low[- ]?fat|ice\\s+cream|cottage|sour\\s+cream|eggnog)\\b).*\\bwhole\\b.*\\bmilk\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/004/410/012/2392/front_en.3.400.jpg",
        // Provenance: OFF 39369635 (US) — front photo visually verified 2026-11-19 as Boulder Canyon Malt Vinegar & Sea Salt Kettle Style (classic, NOT avocado-oil).
        Regex("^(?!.*\\b(?:avocado|olive|canyon\\s+cut|rice|veggie|puffs?)\\b).*\\bboulder\\s+canyon\\b.*\\bmalt\\s+vinegar\\b.*\\bchips\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/39369635/front_en.3.400.jpg",
        Regex("\\bdave'?s\\s+killer\\s+bread\\b(?!.*\\b(?:thin[- ]?sliced|bagels?|english\\s+muffins?|rolls?|buns?|bars?)\\b).*\\b21\\s+whole\\s+grains\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/002/376/400/5043/front_en.3.400.jpg",
        Regex("\\bwonder\\b.*\\b(?:classic\\s+)?white\\s+bread\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/007/225/001/1372/front_en.17.400.jpg",
        Regex("\\byoplait\\b.*\\boriginal\\b.*\\bstrawberry\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/007/047/000/4303/front_en.24.400.jpg",
        Regex("\\bstonyfield\\b.*\\bwhole\\s+milk\\b.*\\bplain\\b.*\\byogurt\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/005/215/900/0011/front_en.11.400.jpg",
        Regex("\\bcheez[- ]?it\\b.*\\boriginal\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/002/410/012/2615/front_en.44.400.jpg",
        Regex("\\bpepperidge\\s+farm\\b.*\\bgoldfish\\b.*\\bcheddar\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/001/410/008/4761/front_en.16.400.jpg",
        Regex("\\bmary'?s\\s+gone\\s+crackers\\b.*\\boriginal\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/065/439/124/6006/front_en.3.400.jpg",
        Regex("\\boscar\\s+mayer\\b.*\\bdeli\\s+fresh\\b.*\\b(?:honey\\s+)?smoked\\s+turkey\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/004/470/003/1483/front_en.10.400.jpg",
        Regex("\\bwelch'?s\\b.*\\bmixed\\s+fruit\\s+snacks?\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/003/485/601/5987/front_en.13.400.jpg",
        Regex("\\b(?:larabar|lärabar)\\b.*\\bcashew\\s+cookie\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/002/190/840/9528/front_en.11.400.jpg",
        Regex("\\bthat'?s\\s+it\\b.*\\bapple\\b.*\\bstrawberr", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/638/859/700/4996/front_en.3.400.jpg",
        Regex("\\bsimple\\s+mills\\b.*\\bchocolate\\s+chip\\b.*\\bcookies?\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/84664945/front_en.10.400.jpg",
        Regex("\\boreo\\b.*\\bchocolate\\s+sandwich\\s+cookies?\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/004/400/004/7009/front_en.20.400.jpg",
        Regex("\\beggo\\b.*\\bhomestyle\\b.*\\bwaffles?\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/003/800/040/2609/front_en.21.400.jpg",
        Regex("\\bkraft\\b.*\\bmacaroni\\s*(?:&|and)\\s*cheese\\b.*\\boriginal\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/002/100/003/3720/front_en.15.400.jpg",
        // Provenance: OFF 0747479000017 "Marinara" (Rao's Homemade, US) — rev 12 front visually verified 2026-11-19 (current rev 49 is a nutrition panel, so rev 12 stays pinned).
        Regex("^(?!.*\\b(?:organic|sensitive|roasted|garlic|vodka|arrabbiata|tomato\\s+basil|mushroom|puttanesca|spicy|pizza|soup|pasta|ravioli|frozen|entree|meal|bowl|lasagna)\\b).*\\brao'?s\\b.*\\bmarinara\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/074/747/900/0017/front_en.12.400.jpg",
        Regex("\\bannie'?s\\b.*\\byellow\\s+mustard\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/009/232/522/2243/front_en.5.400.jpg",
        Regex("\\bcoombs\\s+family\\s+farms\\b.*\\bmaple\\s+syrup\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/071/028/232/9644/front_en.3.400.jpg",
        Regex("\\bbob'?s\\s+red\\s+mill\\b.*\\brolled\\s+oats\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/003/997/803/3758/front_en.43.400.jpg",
        Regex("\\balden'?s\\s+organic\\b.*\\bvanilla\\s+bean\\b.*\\bice\\s+cream\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/007/269/274/1851/front_en.3.400.jpg",
        Regex("\\bcoffee[- ]?mate\\b.*\\bfrench\\s+vanilla\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/005/000/032/2756/front_en.31.400.jpg",
        Regex("\\bcapri\\s*sun\\b.*\\bstrawberry\\s+kiwi\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/008/768/400/0991/front_en.14.400.jpg",
        Regex("\\bhu\\b.*\\bsimple\\b.*\\bdark\\s+chocolate\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/123/000/009/7000/front_en.18.400.jpg",
        Regex("\\bmonster\\b.*\\b(?:zero\\s+ultra|ultra\\s+white)\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/007/084/789/2519/front_en.3.400.jpg",
        Regex("\\bmonster\\s+energy\\b(?!.*\\b(?:zero|ultra|lo[- ]?carb|rehab|java|juice|mango)\\b).*\\b(?:original|green)\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/007/084/703/7712/front_en.8.400.jpg",
        Regex("^(?!.*\\b(?:edition|amber|blue|yellow|peach|coconut|watermelon|strawberry|juneberry)\\b).*\\bred\\s*bull\\b.*\\bsugar\\s*free\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/900/249/025/7064/front_en.4.400.jpg",
        Regex("^(?!.*\\b(?:sugar\\s*free|zero|edition|amber|blue|yellow|peach|coconut|watermelon|strawberry|juneberry|tropical|dragon|apricot|curuba)\\b).*\\bred\\s*bull\\b.*\\benergy\\s+drink\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/900/249/020/5973/front_en.104.400.jpg",
        Regex("\\bcelsius\\b.*\\bsparkling\\s+orange\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/088/939/200/0412/front_en.3.400.jpg",
        Regex("\\bc4\\b.*\\bicy\\s+blue\\s+razz\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/084/259/510/5575/front_en.3.400.jpg",
        Regex("\\b(?:guayaki|guayakí)\\b.*\\byerba\\s+mate\\b.*\\benlighten\\s+mint\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/063/243/200/0046/front_en.6.400.jpg",
        Regex("\\bora\\s+organic\\b.*\\b(?:renewable|pre[- ]?workout)\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/085/672/000/7115/front_en.3.400.jpg",
        Regex("\\bcore\\s+power\\b(?!.*\\b(?:elite|42\\s*g|vanilla|strawberry|banana)\\b).*\\bchocolate\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/061/134/003/2066/front_en.3.400.jpg",
        Regex("\\borgain\\b(?!.*\\b(?:powder|tub|kids|plant|vegan)\\b).*\\bclean\\s+protein\\s+shake\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/085/177/000/8938/front_en.3.400.jpg",
        Regex("^(?!.*\\b(?:zero|diet|cherry|vanilla|caffeine[- ]?free|spiced|orange|lime|lemon|mexican|cane\\s+sugar|life|coffee)\\b).*\\bcoca[- ]?cola\\b.*\\b(?:classic|original)\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/004/900/002/8904/front_en.16.400.jpg",
        Regex("^(?!.*\\b(?:caffeine[- ]?free|lime|cherry|mango)\\b).*\\bdiet\\s+coke\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/004/900/002/4692/front_en.11.400.jpg",
        Regex("^(?!.*\\b(?:diet|zero|code\\s+red|baja|voltage|major\\s+melon|spark)\\b).*\\b(?:mountain|mtn)\\s+dew\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/001/200/003/2448/front_en.12.400.jpg",
        Regex("\\bolipop\\b.*\\bvintage\\s+cola\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/086/948/401/5005/front_en.3.400.jpg",
        Regex("\\bpoppi\\b.*\\bstrawberry\\s+lemon\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/081/006/371/0668/front_en.3.400.jpg",
        Regex("\\bfiji\\b.*\\bwater\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/941/757/400/1424/front_en.3.400.jpg",
        Regex("\\bspindrift\\b.*\\blemon\\b(?!\\s*(?:lime|iced\\s+tea))", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/085/657/900/2910/front_en.19.400.jpg",
        Regex("^(?!.*\\b(?:powder|canister|zero|g2|fit|mix|packets?|sticks?|pods?|chews?|lyte)\\b).*\\bgatorade\\b.*\\bfruit\\s+punch\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/005/200/024/1211/front_en.12.400.jpg",
        Regex("\\bprime\\b.*\\bhydration\\b.*\\bice\\s+pop\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/085/004/000/5226/front_en.3.400.jpg",
        Regex("\\bsimply\\s+orange\\b(?!.*\\b(?:mango|pineapple|calcium|high\\s+pulp|with\\s+pulp|some\\s+pulp|light)\\b)", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/002/500/010/0000/front_en.30.400.jpg",
        Regex("\\buncle\\s+matt'?s\\b.*\\borange\\s+juice\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/069/706/852/0139/front_en.12.400.jpg",
        Regex("\\bharmless\\s+harvest\\b.*\\bcoconut\\s+water\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/85902800/front_en.3.400.jpg",
        Regex("\\bsunny\\s*d\\b.*\\btangy\\s+original\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/005/020/012/1005/front_en.3.400.jpg",
        Regex("\\bstarbucks\\b.*(?:\\bmocha\\b.*\\bfrappuccino\\b|\\bfrappuccino\\b.*\\bmocha\\b)", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/001/200/000/4520/front_en.4.400.jpg",
        Regex("\\bstok\\b.*\\bunsweetened\\b.*\\bcold\\s+brew\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/003/663/207/2634/front_en.3.400.jpg",
        Regex("\\bfairlife\\b(?!.*\\b(?:chocolate|strawberry|skim|fat\\s*free|whole)\\b).*\\b2%\\b.*\\bmilk\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/081/162/002/0169/front_en.83.400.jpg",
        Regex("\\bmalk\\b(?!.*\\b(?:vanilla|chocolate)\\b).*\\bunsweetened\\b.*\\boat\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/076/574/644/4432/front_en.3.400.jpg",
        Regex("\\bmalk\\b(?!.*\\b(?:vanilla|chocolate)\\b).*\\bunsweetened\\b.*\\balmond\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/085/003/046/4040/front_en.3.400.jpg",
        Regex("\\bcalifia\\b(?!.*\\b(?:barista|vanilla|creamer)\\b).*\\borganic\\b.*\\boat", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/081/363/602/1932/front_en.30.400.jpg",
        Regex("\\bcalifia\\b(?!.*\\b(?:barista|vanilla|creamer)\\b).*\\borganic\\b.*\\balmond", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/085/290/900/3855/front_en.9.400.jpg",
        Regex("\\boatly\\b(?!.*\\b(?:chocolate|barista|full\\s+fat|super\\s+basic|vanilla|low\\s*fat|ice\\s+cream|creamer)\\b).*\\b(?:original|oat\\s*milk)\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/001/906/466/4110/front_en.3.400.jpg",
        Regex("\\bnesquik\\b.*\\bchocolate\\b.*\\b(?:powder|syrup|milk)\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/002/800/077/1720/front_en.3.400.jpg",
        Regex("\\bhorizon\\s+organic\\b.*\\bchocolate\\b.*\\bmilk\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/003/663/207/8513/front_en.3.400.jpg",
        Regex("\\bsimple\\s+truth\\b.*\\bplain\\b.*\\bgreek\\s+yogurt\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/001/111/010/8333/front_en.3.400.jpg",
        Regex("\\bbig\\s+k\\b(?!.*\\b(?:zero|diet)\\b).*\\bcola\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/001/111/049/1053/front_en.3.400.jpg",
        Regex("\\bprivate\\s+selection\\b(?!.*\\b(?:roast\\s+beef|deli|sliced|jerky|steaks?|hot\\s*dogs?|franks?|meatballs?|chili|soup|seasoning)\\b).*\\bangus\\b.*\\b(?:patt(?:y|ies)|burgers?)\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/001/111/022/0691/front_en.3.400.jpg",
        Regex("\\bfavorite\\s+day\\b.*\\bnon[- ]?dairy\\b.*\\bvanilla\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/008/523/914/1694/front_en.8.400.jpg",
        Regex("\\bfavorite\\s+day\\b.*\\bcookies\\s*(?:&|and)\\s*cream\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/008/523/915/7756/front_en.3.400.jpg",
        Regex("^(?!.*\\b(?:bacon|ground|burgers?|patt(?:y|ies)|sausage|deli|sliced|meatballs?|franks?|hot\\s*dogs?|jerky|breast)\\b).*\\bbutterball\\b.*\\bturkey\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/023/007/223/1082/front_en.3.400.jpg",
        Regex("^(?!.*\\borganics?\\b).*\\bapplegate\\b.*\\broast\\s+beef\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/002/531/715/6745/front_en.12.400.jpg",
        Regex("^(?!.*\\borganics?\\b).*\\bapplegate\\b.*\\b(?:hot\\s*dog|frank)\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/002/531/753/2006/front.3.400.jpg",
        Regex("^(?!.*\\borganics?\\b).*\\bapplegate\\b.*\\bbacon\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/002/531/733/1005/front_en.3.400.jpg",
        Regex("^(?!.*\\borganics?\\b).*\\bapplegate\\b.*\\bblack\\s+forest\\s+ham\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/002/531/700/5906/front_en.5.400.jpg",
        Regex("\\bapplegate\\b.*\\borganic.*\\bsalami\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/002/531/765/6009/front_en.25.400.jpg",
        Regex("^(?!.*\\borganics?\\b).*\\bapplegate\\b.*\\bsalami\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/002/531/766/8569/front_en.4.400.jpg",
        Regex("^(?!.*\\borganics?\\b).*\\bapplegate\\b.*\\bbreakfast\\s+sausage\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/002/531/700/5890/front_en.5.400.jpg",
        Regex("\\bapplegate\\b.*\\borganic.*\\bnuggets?\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/002/531/760/5519/front_en.6.400.jpg",
        Regex("^(?!.*\\borganics?\\b).*\\bapplegate\\b.*\\bnuggets?\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/002/531/705/5192/front_en.22.400.jpg",
        Regex("^(?!.*\\b(?:bunnies|popcorn|crackers?|puffs?|grahams?|gummies|fruit|bars?|soup)\\b).*\\bannie'?s\\b.*\\b(?:shells|white\\s+cheddar|mac(?:aroni)?)\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/26565859/front_en.3.400.jpg",
        Regex("\\blotus\\s+foods\\b.*\\bramen\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/070/895/362/8172/front_en.3.400.jpg",
        Regex("\\bmarketside\\s+butcher\\b.*\\bground\\s+beef\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/068/113/137/7416/front_en.3.400.jpg",
        Regex("\\bverde(?:\\s+farms)?\\b.*\\bground\\s+beef\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/082/581/911/0319/front_en.14.400.jpg",
        Regex("^(?!.*\\b(?:bacon|sausage)\\b).*\\bsmithfield\\b.*\\bham\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/020/634/010/5485/front_en.3.400.jpg",
        Regex("^(?!.*\\b(?:bites?|butter|liquid)\\b).*\\bvital\\s+farms\\b.*\\beggs?\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/086/174/500/0010/front_en.27.400.jpg",
        Regex("\\bgreat\\s+value\\b(?!.*\\b(?:organic|unsalted)\\b).*\\bbutter\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/007/874/202/5933/front_en.16.400.jpg",
        Regex("^(?!.*\\b(?:bites?|liquid|salad)\\b).*\\bgreat\\s+value\\b.*\\beggs?\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/007/874/233/0624/front_en.3.400.jpg",
        Regex("\\bgreat\\s+value\\b.*\\b(?:macaroni|mac\\s*(?:&|and)\\s*cheese)\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/007/874/235/8857/front_en.4.400.jpg",
        Regex("\\bgreat\\s+value\\b.*\\bdiced\\s+tomatoes\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/007/874/202/0976/front_en.4.400.jpg",
        Regex("\\bgreat\\s+value\\b.*\\bpurified\\s+drinking\\s+water\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/84464033/front_en.3.400.jpg",
        Regex("^(?!.*\\b(?:no\\s+sugar|simply|organic|jalapeno|habanero|pickle|mayochup|kranch|mustard|relish|bbq|vinegar|gravy|beans)\\b).*\\bheinz\\b.*\\btomato\\s+ketchup\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/001/300/000/6408/front_en.26.400.jpg",
        Regex("^(?!.*\\b(?:light|olive|avocado|vegan|plant|garlic|spicy|chipotle|drizzle|organic)\\b).*\\b(?:hellmann'?s|best\\s+foods)\\b.*\\breal\\s+(?:mayo|mayonnaise)\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/004/800/121/3487/front_en.105.400.jpg",
        Regex("^(?!.*\\b(?:banana|honey\\s+nut|multi[- ]?grain|apple|chocolate|frosted|berry|protein|oat\\s+crunch|cinnamon|peach|strawberry|vanilla|maple|veggie|pumpkin|ancient|bars?|treats?|nut)\\b).*\\bcheerios\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/001/600/027/5287/front_en.8.400.jpg",
        Regex("^(?!.*\\b(?:crunchy|extra\\s+crunchy|natural|no\\s+added|reduced|honey|chocolate|whips)\\b).*\\bjif\\b.*\\bcreamy\\b.*\\bpeanut\\s+butter\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/005/150/025/5162/front_en.197.400.jpg",
        Regex("^(?!.*\\b(?:honey|dijon|spicy|horseradish|creamy|stone\\s+ground|organic)\\b).*\\bfrench'?s\\b.*\\byellow\\s+mustard\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/004/150/000/0251/front_en.9.400.jpg",
        Regex("^(?!.*\\b(?:flip|zero\\s+sugar|whole\\s+milk|low[- ]?fat|vanilla|strawberry|blueberry|peach|mango|cherry|coconut|banana|lemon|key\\s+lime|drink|complete|creamer|oat)\\b).*\\bchobani\\b.*(?:\\b(?:non[- ]?fat|nonfat)\\b.*\\bplain\\b|\\bplain\\b.*\\b(?:non[- ]?fat|nonfat)\\b).*\\bgreek\\s+yogurt\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/081/829/001/0469/front_en.4.400.jpg",
        Regex("^(?!.*\\b(?:b-ready|biscuits?|go|mini\\s+cups?|ice\\s+cream)\\b).*\\bnutella\\b.*\\b(?:hazelnut|spread)\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/000/980/089/5007/front_en.106.400.jpg",
        Regex("^(?!.*\\b(?:chips?|crisps?|fries|tots|mashed|salad|baby|gerber|pouch|puree|dog|treats?|pet|pie|casserole)\\b).*\\b(?:sweet\\s+potato(?:es)?|yams?)\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/017/620/200/0336/front_en.7.400.jpg",
        Regex("^(?!.*\\b(?:chips?|crisps?|fries|tots|mashed|salad|soup|chowder|au\\s+gratin|scalloped)\\b).*\\b(?:russet\\s+potato(?:es)?|idaho\\s+potato(?:es)?|yukon\\s+gold\\s+potato(?:es)?|red\\s+potato(?:es)?|yellow\\s+potato(?:es)?|butter\\s+potato(?:es)?|potatoes,?\\s+butter|fresh\\s+whole\\s+potato(?:es)?)\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/007/078/401/2964/front_en.3.400.jpg",
        Regex("^(?!.*\\b(?:peppers?|pudding|bread|muffins?|chips?|boat|sunscreen|cereal|cheerios|yogurt|baby|gerber|pouch|puree|oatmeal|bars?|dog|treats?|pet|smoothie|milk|ice\\s+cream)\\b).*\\b(?:fresh\\s+bananas?|bananas?)\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/200/000/015/1418/front_en.3.400.jpg",
        Regex("^(?!.*\\b(?:juice|cider|sauce|applesauce|pie|chips?|strudel|fritter|danish|cereal|cheerios|oatmeal|bars?|baby|gerber|pouch|puree|dog|treats?|pet|vinegar|yogurt)\\b).*\\b(?:honeycrisp\\s+apples?|gala\\s+apples?|fuji\\s+apples?|granny\\s+smith\\s+apples?|fresh\\s+apples?)\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/002/290/630/0183/front_en.3.400.jpg",
        Regex("^(?!.*\\b(?:cake|juice|soup|baby|gerber|pouch|puree|dog|treats?|pet|sticks?|ranch)\\b).*\\b(?:baby\\s+cut\\s+carrots?|whole\\s+carrots?|fresh\\s+carrots?)\\b", RegexOption.IGNORE_CASE) to "https://images.openfoodfacts.org/images/products/003/582/608/6372/front_en.3.400.jpg"
    )

    private val REVOKED_OFF_IMAGE_RE = Regex(
        "/(?:10603499|468/112/060/0422|009/396/600/6469|022/517/201/1436|068/113/139/5502|084/013/430/8029|005/200/012/2022|001/111/000/5526|008/523/927/0233|004/450/020/1956|008/523/905/3218|077/185/646/5793|029/961/630/1971|003/800/031/6104|490/100/207/5484)/"
    )

    private val NON_US_FOREIGN_OFF_FRONT_TOKENS = listOf(
        "/front_de.",
        "/front_it.",
        "/front_nl.",
        "/front_pl.",
        "/front_pt.",
        "/front_ru.",
        "/front_ja.",
        "/front_zh.",
        "/front_ar."
    )

    private val NON_BRAND_PLACEHOLDER_RE = Regex(
        "(?:category\\s+estimate|representative(?:\\s+category)?\\s+formulation|verify\\s+package\\s+label)",
        RegexOption.IGNORE_CASE
    )

    private val GENERIC_NON_BRAND_EXACT_RE = Regex(
        "^(?:usda|fresh(?:\\s+produce|\\s+meat|\\s+fruit|\\s+vegetables?)?|produce|whole\\s+nuts|category\\s+estimate|scanned\\s+product|generic|conventional|grocery|unbranded|unknown|n/a|none)$",
        RegexOption.IGNORE_CASE
    )

    private val NON_FOOD_OR_APPLIANCE_RE = Regex(
        "\\b(?:\\d{2,4}\\s*w\\b|watts?\\b|quesadilla\\s+maker|waffle\\s+maker|coffee\\s+maker|espresso\\s+machine|air\\s+fryer|slow\\s+cooker|pressure\\s+cooker|rice\\s+cooker|toaster(?:\\s+oven)?(?!\\s+pastr(?:y|ies))|blender|food\\s+processor|stand\\s+mixer|hand\\s+mixer|microwave|electric\\s+kettle|griddle|skillet|frying\\s+pan|saucepan|cookware|bakeware|spatula|tongs|cutting\\s+board|3\\s+claveles|claveles\\s+prof|kitchen\\s+shears?|poultry\\s+shears?|scissors?|shears?|cutlery|chef'?s?\\s+knif(?:e|es)|paring\\s+knif(?:e|es)|steak\\s+knif(?:e|es)|bread\\s+knif(?:e|es)|utility\\s+knif(?:e|es)|boning\\s+knif(?:e|es)|fillet\\s+knif(?:e|es)|knife\\s+set|knife\\s+sharpener|meat\\s+cleaver|peeler|box\\s+grater|cheese\\s+grater|colander|strainer|can\\s+opener|bottle\\s+opener|corkscrew|meat\\s+thermometer|kitchen\\s+scale|measuring\\s+cups?|measuring\\s+spoons?|mixing\\s+bowls?|baking\\s+sheet|muffin\\s+pan|loaf\\s+pan|whisk|storage\\s+containers?|food\\s+wrap|aluminum\\s+foil|parchment\\s+paper|zip\\s*top\\s+bags?|freezer\\s+bags?|trash\\s+bags?|garbage\\s+bags?|paper\\s+towels?|toilet\\s+paper|bath\\s+tissue|facial\\s+tissue|napkins|paper\\s+plates|plastic\\s+cups|laundry\\s+detergent|fabric\\s+softener|dryer\\s+sheets?|dish\\s+soap|dishwasher\\s+pods?|bleach|disinfectant|surface\\s+cleaner|glass\\s+cleaner|sponges?|shampoo|conditioner|body\\s+wash|face\\s+wash|cleanser|moisturizer|lotion|sunscreen|spf\\s*\\d+|deodorant|antiperspirant|toothpaste|mouthwash|dental\\s+floss|toothbrush|razors?|shaving\\s+cream|diapers?|baby\\s+wipes|tampons?|sanitary\\s+pads?|cat\\s+litter|dog\\s+toy|pet\\s+bed|collar|leash|alkaline\\s+batter(?:y|ies)|aa\\s+batteries|aaa\\s+batteries|usb[- ]?c|charging\\s+cable|light\\s+bulbs?|candles?|air\\s+freshener)\\b",
        RegexOption.IGNORE_CASE
    )

    private val FOOD_INGREDIENT_SIGNAL_RE = Regex(
        "\\b(?:water|sugar|salt|flour|milk|cream|oil|butter|corn|wheat|rice|oats?|soy|cocoa|chocolate|cheese|egg|chicken|beef|pork|turkey|tomato|citric\\s+acid|natural\\s+flavors?|vinegar|spices?|yeast|honey|syrup|juice|tea|coffee|beans?|peanuts?|almonds?|cashews?)\\b",
        RegexOption.IGNORE_CASE
    )

    private val STUDIO_ART_RULES: List<Pair<Regex, String>> = listOf(
        Regex("\\b(?:baby\\s+food|gerber|1st\\s+foods|2nd\\s+foods|infant\\s+formula|toddler\\s+puree|baby\\s+puree)\\b", RegexOption.IGNORE_CASE) to "/swaps/baby-food.png",
        Regex("\\b(?:peanut\\s+butter|almond\\s+butter|cashew\\s+butter|sunflower\\s+(?:seed\\s+)?butter|sunbutter|nut\\s+butter)\\b", RegexOption.IGNORE_CASE) to "/swaps/peanutbutter.png",
        Regex("\\b(?:coffee\\s+creamer|liquid\\s+creamer|dairy\\s+creamer|oat\\s+creamer|almond\\s+creamer|superfood\\s+creamer|non[- ]?dairy.*creamer|coffee[- ]?mate|international\\s+delight|nutpods|half\\s*(?:&|and)\\s*half|creamer)\\b", RegexOption.IGNORE_CASE) to "/swaps/creamer.png",
        Regex("\\b(?:protein\\s+shake|protein\\s+powder|whey\\s+protein|plant\\s+protein|core\\s+power|premier\\s+protein|muscle\\s+milk|orgain.*shake|fairlife.*nutrition\\s+plan|meal\\s+replacement\\s+shake)\\b", RegexOption.IGNORE_CASE) to "/swaps/protein-shake.png",
        Regex("\\b(?:energy\\s+drink|energy\\s+shot|5[- ]?hour\\s+energy|five\\s+hour\\s+energy|pre[- ]?workout|monster\\s+energy|red\\s*bull|celsius|c4\\s+(?:energy|performance)|ghost\\s+energy|alani\\s+nu|reign|rockstar\\s+energy|bang\\s+energy)\\b", RegexOption.IGNORE_CASE) to "/swaps/energy-drink.png",
        Regex("\\b(?:cold\\s+brew|frappuccino|espresso|roast\\s+coffee|ground\\s+coffee|instant\\s+coffee|iced\\s+coffee|coffee)\\b", RegexOption.IGNORE_CASE) to "/swaps/coffee.png",
        Regex("\\b(?:iced\\s+tea|green\\s+tea|black\\s+tea|herbal\\s+tea|chamomile|earl\\s+grey|matcha|chai\\s+latte|yerba\\s+mate|kombucha|tea)\\b", RegexOption.IGNORE_CASE) to "/swaps/tea.png",
        Regex("\\b(?:sparkling\\s+water|spring\\s+water|mineral\\s+water|purified\\s+(?:drinking\\s+)?water|artesian\\s+water|alkaline\\s+water|seltzer|spindrift|lacroix|topo\\s+chico|liquid\\s+death|coconut\\s+water|water)\\b", RegexOption.IGNORE_CASE) to "/swaps/water.png",
        Regex("\\b(?:orange\\s+juice|apple\\s+juice|cranberry\\s+juice|grape\\s+juice|lemonade|limeade|fruit\\s+punch|tropical\\s+punch|citrus\\s+punch|hawaiian\\s+punch|kool[- ]?aid|drink\\s+pouches?|capri\\s*sun|sunny\\s*d|juice\\s+drink|smoothie|juice)\\b", RegexOption.IGNORE_CASE) to "/swaps/juice.png",
        Regex("\\b(?:sports\\s+drink|electrolyte|hydration\\s+drink|thirst\\s+quencher|gatorade|powerade|bodyarmor|liquid\\s*i\\.?v\\.?|pedialyte|prime\\s+hydration|nooma)\\b", RegexOption.IGNORE_CASE) to "/swaps/drink.png",
        Regex("\\b(?:soda|cola|coca[- ]?cola|pepsi|diet\\s+coke|mountain\\s+dew|mtn\\s+dew|dr\\s+pepper|sprite|7\\s*up|root\\s+beer|ginger\\s+ale|fanta|sunkist|olipop|poppi|prebiotic\\s+soda)\\b", RegexOption.IGNORE_CASE) to "/swaps/soda.png",
        Regex("\\b(?:mac(?:aroni)?\\s*(?:&|and)\\s*cheese|shells?\\s*(?:&|and)\\s*(?:white\\s+)?cheddar|velveeta\\s+shells|easy\\s+mac)\\b", RegexOption.IGNORE_CASE) to "/swaps/mac.png",
        Regex("\\b(?:pizza|flatbread\\s+pizza|pizza\\s+rolls?|digiorno|red\\s+baron|totino'?s)\\b", RegexOption.IGNORE_CASE) to "/swaps/pizza.png",
        Regex("\\b(?:frozen\\s+(?:meal|dinner|entree|bowl|stuffed\\s+sandwich)|stuffed\\s+sandwich.*entree|entrees?|burrito\\s+bowl|power\\s+bowl|lean\\s+cuisine|healthy\\s+choice|stouffer'?s|marie\\s+callender'?s|banquet|hungry[- ]?man|lasagna|pot\\s+pie|taquitos?|chimichangas?|hot\\s+pockets?)\\b", RegexOption.IGNORE_CASE) to "/swaps/frozen-meal.png",
        Regex("\\b(?:chicken\\s+nuggets?|chicken\\s+tenders?|chicken\\s+strips?|chicken\\s+bites?|chicken\\s+patties|popcorn\\s+chicken|dino\\s+buddies)\\b", RegexOption.IGNORE_CASE) to "/swaps/nuggets.png",
        Regex("\\b(?:hot\\s*dogs?|franks?|frankfurters?|wieners?)\\b", RegexOption.IGNORE_CASE) to "/swaps/hotdog.png",
        Regex("\\b(?:bacon|turkey\\s+bacon)\\b", RegexOption.IGNORE_CASE) to "/swaps/bacon.png",
        Regex("\\b(?:sausages?|bratwurst|kielbasa|chorizo|breakfast\\s+links?)\\b", RegexOption.IGNORE_CASE) to "/swaps/sausage.png",
        Regex("\\b(?:ground\\s+beef|beef\\s+patt(?:y|ies)|burger\\s+patt(?:y|ies)|plant[- ]?based\\s+patt(?:y|ies)|veggie\\s+burgers?|angus\\s+beef|ribeye|sirloin|chuck\\s+roast|roast\\s+beef|beef\\s+jerky|steak|beef)\\b", RegexOption.IGNORE_CASE) to "/swaps/beef.png",
        Regex("\\b(?:salmon|tuna|tilapia|cod|halibut|mahimahi|shrimp|fish\\s+sticks?|fish\\s+fillets?|sardines|crab)\\b", RegexOption.IGNORE_CASE) to "/swaps/fish.png",
        Regex("\\b(?:turkey|ham|salami|pepperoni|bologna|prosciutto|deli\\s+meat|lunch\\s*meat|lunchables?|rotisserie(?:\\s+whole)?\\s+chicken|whole\\s+chicken|chicken\\s+breast)\\b", RegexOption.IGNORE_CASE) to "/swaps/turkey.jpg",
        Regex("\\b(?:bone\\s+broth|chicken\\s+broth|beef\\s+broth|vegetable\\s+broth|chicken\\s+stock|beef\\s+stock|broth|gravy)\\b", RegexOption.IGNORE_CASE) to "/swaps/broth.png",
        Regex("\\b(?:soup|clam\\s+chowder|corn\\s+chowder|tomato\\s+bisque|ramen\\s+noodle\\s+soup|chili)\\b", RegexOption.IGNORE_CASE) to "/swaps/soup.png",
        Regex("\\b(?:marinara|pasta\\s+sauce|tomato\\s+basil\\s+sauce|vodka\\s+sauce|alfredo\\s+sauce|spaghetti\\s+sauce|pizza\\s+sauce)\\b", RegexOption.IGNORE_CASE) to "/swaps/marinara.png",
        Regex("\\b(?:salsa|pico\\s+de\\s+gallo|guacamole|queso(?:\\s+dip)?|hummus|tzatziki|baba\\s+ganoush|(?:french\\s+onion|yogurt|spinach|artichoke|bean|cheese|buffalo|ranch|veggie|vegetable)\\s+dip|dip)\\b", RegexOption.IGNORE_CASE) to "/swaps/salsa.png",
        Regex("\\b(?:ranch\\s+dressing|caesar\\s+dressing|italian\\s+dressing|vinaigrette|salad\\s+dressing|ranch)\\b", RegexOption.IGNORE_CASE) to "/swaps/ranch.jpg",
        Regex("\\b(?:mayonnaise|mayo|aioli)\\b", RegexOption.IGNORE_CASE) to "/swaps/mayo.png",
        Regex("\\b(?:ketchup|catsup)\\b", RegexOption.IGNORE_CASE) to "/swaps/ketchup.png",
        Regex("\\b(?:mustard|dijon)\\b", RegexOption.IGNORE_CASE) to "/swaps/mustard.png",
        Regex("\\b(?:bbq\\s+sauce|barbecue\\s+sauce|steak\\s+sauce|teriyaki\\s+sauce|soy\\s+sauce|tamari|worcestershire)\\b", RegexOption.IGNORE_CASE) to "/swaps/bbq.png",
        Regex("\\b(?:hot\\s+sauce|sriracha|tabasco|cholula|frank'?s\\s+redhot|buffalo\\s+sauce|relish|pickles?|olives?|wasabi|sauerkraut|kimchi|horseradish|tartar\\s+sauce|cocktail\\s+sauce)\\b", RegexOption.IGNORE_CASE) to "/swaps/condiments.png",
        Regex("\\b(?:jam|jelly|(?:fruit|strawberry|raspberry|blueberry|berry|apricot|grape|fig)\\s+spread|preserves|marmalade|uncrustables?)\\b", RegexOption.IGNORE_CASE) to "/swaps/jam.png",
        Regex("\\b(?:maple\\s+syrup|pancake\\s+syrup|agave\\s+nectar|honey)\\b", RegexOption.IGNORE_CASE) to "/swaps/syrup.png",
        Regex("\\b(?:ice\\s+cream|gelato|sorbet|sherbet|frozen\\s+dessert|popsicles?|ice\\s+bars?)\\b", RegexOption.IGNORE_CASE) to "/swaps/icecream.png",
        Regex("\\b(?:popcorn|kettle\\s+corn|skinny\\s*pop|smartfood|boomchickapop)\\b", RegexOption.IGNORE_CASE) to "/swaps/popcorn.png",
        Regex("\\b(?:tortilla\\s+chips?|potato\\s+chips?|kettle\\s+chips?|corn\\s+chips?|veggie\\s+straws?|pita\\s+chips?|plantain\\s+chips?|french\\s+fries|crinkle\\s+fries|golden\\s+crinkles|tater\\s+tots?|hash\\s*browns?|doritos|fritos|cheetos|pringles|lay'?s|ruffles|tostitos|takis|siete.*chips?|chips)\\b", RegexOption.IGNORE_CASE) to "/swaps/chips.jpg",
        Regex("\\b(?:crackers?|rice\\s+cakes?|goldfish|cheez[- ]?it|ritz|triscuit|wheat\\s+thins|saltines|graham\\s+crackers?|pretzels?)\\b", RegexOption.IGNORE_CASE) to "/swaps/crackers.jpg",
        Regex("\\b(?:cookies?|oreos?|chips\\s+ahoy|shortbread|biscotti|wafers?)\\b", RegexOption.IGNORE_CASE) to "/swaps/cookies.png",
        Regex("\\b(?:chocolate|cocoa|brownie|fudge|nutella|hazelnut\\s+spread|reese'?s|hershey'?s|m&m'?s|snickers|twix|kit\\s*kat|truffles?)\\b", RegexOption.IGNORE_CASE) to "/swaps/chocolate.png",
        Regex("\\b(?:gummies|gummy|fruit\\s+snacks?|candy|candies|skittles|starburst|sour\\s+patch|swedish\\s+fish|jelly\\s+beans?|licorice|lollipops?|mints?|chewing\\s+gum|marshmallows?)\\b", RegexOption.IGNORE_CASE) to "/swaps/candy.png",
        Regex("\\b(?:fruit\\s+bars?|granola\\s+bars?|protein\\s+bars?|snack\\s+bars?|energy\\s+bars?|nut\\s+bars?|larabar|lärabar|rxbar|clif\\s+bar|kind\\s+bar|nature\\s+valley|that'?s\\s+it)\\b", RegexOption.IGNORE_CASE) to "/swaps/fruitbar.png",
        Regex("\\b(?:almonds?|cashews?|walnuts?|pecans?|pistachios?|macadamia|mixed\\s+nuts|peanuts?|pumpkin\\s+seeds?|sunflower\\s+seeds?|chia\\s+seeds?|flax\\s*seeds?|hemp\\s+hearts?|trail\\s+mix)\\b", RegexOption.IGNORE_CASE) to "/swaps/nuts-seeds.png",
        Regex("\\b(?:sprouted\\s+oat\\s+o'?s|oat\\s+o'?s|heritage\\s+flakes|bran\\s+flakes|corn\\s+flakes|oat\\s+flakes|cereal|cheerios|frosted\\s+flakes|cinnamon\\s+toast\\s+crunch|froot\\s+loops|lucky\\s+charms|granola|muesli|three\\s+wishes|kix)\\b", RegexOption.IGNORE_CASE) to "/swaps/cereal.jpg",
        Regex("\\b(?:rolled\\s+oats|steel\\s+cut\\s+oats|instant\\s+oatmeal|oatmeal|oats)\\b", RegexOption.IGNORE_CASE) to "/swaps/oats.png",
        Regex("\\b(?:waffles?|pancakes?|eggo|french\\s+toast|pancake\\s+mix)\\b", RegexOption.IGNORE_CASE) to "/swaps/waffles.png",
        Regex("\\b(?:bagels?)\\b", RegexOption.IGNORE_CASE) to "/swaps/bagels.png",
        Regex("\\b(?:tortillas?|wraps?|taco\\s+shells?)\\b", RegexOption.IGNORE_CASE) to "/swaps/tortillas.png",
        Regex("\\b(?:hamburger\\s+buns?|hot\\s+dog\\s+buns?|brioche\\s+buns?|dinner\\s+rolls?|sandwich\\s+rolls?|potato\\s+rolls?|hoagie\\s+rolls?|sub\\s+rolls?|slider\\s+buns?|buns)\\b", RegexOption.IGNORE_CASE) to "/swaps/buns.png",
        Regex("\\b(?:croissants?|muffins?|cupcakes?|cakes?|snack\\s+cakes?|donuts?|doughnuts?|bismarks?|danish|cinnamon\\s+rolls?|pastr(?:y|ies)|pie\\s+crust|pop[- ]?tarts?|toaster\\s+pastr(?:y|ies))\\b", RegexOption.IGNORE_CASE) to "/swaps/bakery.png",
        Regex("\\b(?:bread|sourdough|english\\s+muffins?|baguette|ciabatta|ezekiel)\\b", RegexOption.IGNORE_CASE) to "/swaps/bread.jpg",
        Regex("\\b(?:yogurt|yoghurt|greek\\s+yogurt|sour\\s+cream|skyr|kefir|chobani|yoplait|fage|siggi'?s|stonyfield)\\b", RegexOption.IGNORE_CASE) to "/swaps/yogurt.jpg",
        Regex("\\b(?:butter|buttery\\s+spread|margarine|ghee|kerrygold|country\\s+crock|earth\\s+balance)\\b", RegexOption.IGNORE_CASE) to "/swaps/butter.jpg",
        Regex("\\b(?:cheese|mozzarella|cheddar|parmesan|provolone|gouda|swiss\\s+cheese|brie|feta|ricotta|cottage\\s+cheese|cream\\s+cheese|string\\s+cheese|kraft\\s+singles)\\b", RegexOption.IGNORE_CASE) to "/swaps/cheese.png",
        Regex("\\b(?:milk|oatmilk|oat\\s+milk|oat\\s+beverage|almondmilk|almond\\s+milk|almond\\s+beverage|soymilk|soy\\s+milk|soy\\s+beverage|coconutmilk|coconut\\s+milk|coconut\\s+beverage|eggnog|heavy\\s+(?:whipping\\s+)?cream|whipping\\s+cream|lactaid|fairlife)\\b", RegexOption.IGNORE_CASE) to "/swaps/milk.png",
        Regex("\\b(?:eggs?|pasture[- ]?raised\\s+eggs?|egg\\s+whites?|liquid\\s+egg)\\b", RegexOption.IGNORE_CASE) to "/swaps/eggs.png",
        Regex("\\b(?:pasta|spaghetti|penne|rotini|fusilli|fettuccine|linguine|macaroni|rigatoni|orzo|gnocchi|ramen|noodles?)\\b", RegexOption.IGNORE_CASE) to "/swaps/pasta.png",
        Regex("\\b(?:olive\\s+oil|avocado\\s+oil|coconut\\s+oil|canola\\s+oil|vegetable\\s+oil|sesame\\s+oil|cooking\\s+spray|apple\\s+cider\\s+vinegar|balsamic\\s+vinegar|white\\s+vinegar)\\b", RegexOption.IGNORE_CASE) to "/swaps/oil-vinegar.png",
        Regex("\\b(?:seasoning|spice|cinnamon|paprika|turmeric|cumin|oregano|garlic\\s+powder|onion\\s+powder|black\\s+pepper|sea\\s+salt|pink\\s+salt|taco\\s+seasoning|vanilla\\s+extract)\\b", RegexOption.IGNORE_CASE) to "/swaps/spices.png",
        Regex("\\b(?:green\\s+beans?|string\\s+beans?|french\\s+(?:style\\s+)?green\\s+beans?|wax\\s+beans?|cut\\s+green\\s+beans?|sweet\\s+peas?|green\\s+peas?|snow\\s+peas?|snap\\s+peas?|sugar\\s+snap|edamame|peas|asparagus|zucchini|squash|butternut\\s+squash|brussels\\s+sprouts?|cabbage|beets?|artichokes?|eggplant|okra|radish(?:es)?|scallions?|green\\s+onions?|mixed\\s+vegetables?|canned\\s+vegetables?|corn\\s+kernels?|creamed\\s+corn|applesauce|fruit\\s+crisps?|apples?|peaches?|pears?|plums?|pineapples?|mangos?|mangoes|bananas?|strawberries|blueberries|raspberries|blackberries|grapes?|oranges?|lemons?|limes?|avocados?|tomato(?:es)?|diced\\s+tomatoes|corn|vegetables?|salad\\s+kit|salad|spinach|lettuce|romaine|kale|chard|arugula|broccoli|cauliflower|carrots?|potato(?:es)?|sweet\\s+potato(?:es)?|onions?|garlic|peppers?|cucumbers?|celery|mushrooms?|berries|produce)\\b", RegexOption.IGNORE_CASE) to "/swaps/produce.png",
        Regex("\\b(?:black\\s+beans?|pinto\\s+beans?|kidney\\s+beans?|cannellini\\s+beans?|great\\s+northern\\s+beans?|navy\\s+beans?|butter\\s+beans?|lima\\s+beans?|white\\s+beans?|red\\s+beans?|chili\\s+beans?|garbanzo|chickpeas?|lentils?|refried\\s+beans?|baked\\s+beans?|beans|quinoa|brown\\s+rice|jasmine\\s+rice|basmati\\s+rice|white\\s+rice|rice|couscous|farro|barley|flour|cornmeal|tofu|tempeh)\\b", RegexOption.IGNORE_CASE) to "/swaps/beans-grains.png"
    )

    private val EXPLICIT_CATEGORY_ART_MAP: Map<String, String> = mapOf(
        "chips" to "/swaps/chips.jpg",
        "chips & snacks" to "/swaps/chips.jpg",
        "frozen potatoes" to "/swaps/chips.jpg",
        "crackers" to "/swaps/crackers.jpg",
        "cereal" to "/swaps/cereal.jpg",
        "cereals & granolas" to "/swaps/cereal.jpg",
        "bread" to "/swaps/bread.jpg",
        "yogurt" to "/swaps/yogurt.jpg",
        "yogurt & dairy" to "/swaps/yogurt.jpg",
        "dressings" to "/swaps/ranch.jpg",
        "dressings & sauces" to "/swaps/ranch.jpg",
        "condiments" to "/swaps/condiments.png",
        "deli meat" to "/swaps/turkey.jpg",
        "butter/dairy" to "/swaps/butter.jpg",
        "drinks" to "/swaps/drink.png",
        "beverages" to "/swaps/drink.png",
        "candy" to "/swaps/candy.png",
        "cookies" to "/swaps/cookies.png",
        "frozen" to "/swaps/frozen-meal.png",
        "produce" to "/swaps/produce.png",
        "vegetables" to "/swaps/produce.png",
        "canned goods" to "/swaps/produce.png",
        "pantry" to "/swaps/beans-grains.png",
        "snacks" to "/swaps/snacks.jpg"
    )

    private val STORE_PREFIX_FOR_IMAGE_QUERY_RE = Regex(
        "^(?:amazon\\s+grocery|amazon\\s+fresh|whole\\s+foods\\s+market|365\\s+by\\s+whole\\s+foods(?:\\s+market)?|walmart|target|kroger|costco|instacart)\\s*[,:\\-–—]\\s*",
        RegexOption.IGNORE_CASE
    )

    fun sanitizeApiBrand(rawBrand: String): String {
        val trimmed = rawBrand.trim()
        if (trimmed.isEmpty()) return ""
        if (NON_BRAND_PLACEHOLDER_RE.containsMatchIn(trimmed) || GENERIC_NON_BRAND_EXACT_RE.matches(trimmed)) {
            return ""
        }
        return trimmed
    }

    // Appliance/tool words that routinely appear in real food titles ("Banquet Skillet Meals",
    // "Pork Collar", "Air Fryer Fries", "Toaster Strudel", "Microwave Popcorn"). Mirrors lib/category-art.ts.
    private val AMBIGUOUS_NON_FOOD_RE = Regex(
        "\\b(?:skillet|griddle|collar|strainer|colander|whisk|tongs|spatula|air\\s+fryer|toaster(?!\\s+oven)|microwave|sponges?|blender)\\b",
        RegexOption.IGNORE_CASE
    )

    private val FOOD_TITLE_SIGNAL_RE = Regex(
        "\\b(?:meals?|dinners?|entrees?|bowls?|chicken|beef|pork|turkey|sausages?|cheese|sauce|pasta|noodles?|soup|rice|potato(?:es)?|fries|wings|tots|nuggets|eggs?|pancakes?|cakes?|waffles?|strudel|pastr(?:y|ies)|bread|cereal|snacks?|chips|popcorn|candy|chocolate|cookies?|cream|coffee|tea|milk|juice|yogurt|butter|fruit|vegetables?|salad|pizza|burgers?|fish|shrimp|seasoning|spices?|flour|sugar|oil|steak|ham|bacon|breakfast|burritos?|sandwich(?:es)?|hash\\s*browns?)\\b",
        RegexOption.IGNORE_CASE
    )

    fun isLikelyNonFoodOrAppliance(title: String, ingredients: String = ""): Boolean {
        val cleanTitle = title.trim()
        if (cleanTitle.isEmpty()) return false
        val cleanIng = ingredients.trim()
        if (FOOD_INGREDIENT_SIGNAL_RE.containsMatchIn(cleanIng)) return false
        val hardHit = NON_FOOD_OR_APPLIANCE_RE.containsMatchIn(AMBIGUOUS_NON_FOOD_RE.replace(cleanTitle, " "))
        if (hardHit) return true
        return AMBIGUOUS_NON_FOOD_RE.containsMatchIn(cleanTitle) &&
            !FOOD_TITLE_SIGNAL_RE.containsMatchIn(cleanTitle)
    }

    fun resolveCategoryStudioArt(title: String, category: String = "", ingredients: String = ""): String {
        val cleanTitle = title.trim()
        if (isLikelyNonFoodOrAppliance(cleanTitle, ingredients)) return ""
        if (cleanTitle.isNotEmpty()) {
            for ((re, path) in STUDIO_ART_RULES) {
                if (re.containsMatchIn(cleanTitle)) return "https://www.heybroc.com$path"
            }
        }
        val normCat = category.trim().lowercase()
        if (normCat.isNotEmpty()) {
            EXPLICIT_CATEGORY_ART_MAP[normCat]?.let { return "https://www.heybroc.com$it" }
            for ((re, path) in STUDIO_ART_RULES) {
                if (re.containsMatchIn(normCat)) return "https://www.heybroc.com$path"
            }
        }
        val cleanIng = ingredients.trim()
        if (cleanIng.isNotEmpty()) {
            for ((re, path) in STUDIO_ART_RULES) {
                if (re.containsMatchIn(cleanIng)) return "https://www.heybroc.com$path"
            }
            if (FOOD_INGREDIENT_SIGNAL_RE.containsMatchIn(cleanIng)) {
                return "https://www.heybroc.com/swaps/produce.png"
            }
        }
        // Any scanned grocery item that is not an appliance/non-food gets clean studio art rather than a grey letter tile
        return if (cleanTitle.isNotEmpty()) "https://www.heybroc.com/swaps/produce.png" else ""
    }

    fun isCategoryArtUrl(rawUrl: String): Boolean {
        val low = rawUrl.trim().lowercase()
        return low.startsWith("/swaps/") ||
            low.contains("heybroc.com/swaps/") ||
            low.contains("cleancart-teal.vercel.app/swaps/")
    }

    fun normalizeCategoryArtUrl(rawUrl: String): String {
        val trimmed = rawUrl.trim()
        if (trimmed.isEmpty() || trimmed.equals("null", ignoreCase = true)) return ""
        if (trimmed.startsWith("/swaps/")) return "https://www.heybroc.com$trimmed"
        if (trimmed.startsWith("https://") && isCategoryArtUrl(trimmed)) return trimmed
        return ""
    }

    fun brandInitial(title: String, brand: String = ""): String {
        val cleanBrand = sanitizeApiBrand(brand)
        val skipWords = setOf("the", "a", "an", "fresh", "whole", "raw", "usda", "organic", "natural", "pure")
        for (rawSource in listOf(cleanBrand, title.trim())) {
            if (rawSource.isEmpty()) continue
            val stripped = rawSource.replace(Regex("\\b100\\s*%"), " ")
            val tokens = stripped.split(Regex("[^A-Za-z0-9]+"))
                .map { it.trim() }
                .filter { it.isNotEmpty() && it.lowercase() !in skipWords }
            val alphaToken = tokens.firstOrNull { tok -> tok.any { it.isLetter() } }
            if (alphaToken != null) {
                alphaToken.firstOrNull { it.isLetter() }?.uppercaseChar()?.let { return it.toString() }
            }
            val anyToken = tokens.firstOrNull()
            if (anyToken != null) {
                anyToken.firstOrNull { it.isLetterOrDigit() }?.uppercaseChar()?.let { return it.toString() }
            }
        }
        return "B"
    }

    fun verifiedDirectImageUrl(title: String): String? {
        val t = title.trim()
        if (t.isEmpty()) return null
        return VERIFIED_OFF_IMAGES.firstOrNull { (re, _) -> re.containsMatchIn(t) }?.second
    }

    fun productImageApiFallbackUrl(title: String, brand: String = "", code: String = ""): String {
        val rawTitle = title.trim()
        val strippedTitle = STORE_PREFIX_FOR_IMAGE_QUERY_RE.replace(rawTitle, "").trim()
        val cleanTitle = if (strippedTitle.length >= 4) strippedTitle else rawTitle
        val cleanCode = code.filter { it.isDigit() }.take(14)
        if (cleanTitle.isEmpty() && cleanCode.length < 8) return ""
        if (cleanCode.length < 8 && isLikelyNonFoodOrAppliance(cleanTitle)) return ""
        val sb = StringBuilder("https://www.heybroc.com/api/product-image?q=")
        sb.append(java.net.URLEncoder.encode(cleanTitle, "UTF-8"))
        val rawBrand = sanitizeApiBrand(brand)
        val cleanBrand = if (
            rawBrand.equals("amazon grocery", ignoreCase = true) ||
            rawBrand.equals("amazon fresh", ignoreCase = true)
        ) "" else rawBrand
        if (cleanBrand.isNotEmpty()) {
            sb.append("&brand=").append(java.net.URLEncoder.encode(cleanBrand, "UTF-8"))
        }
        if (cleanCode.length >= 8) {
            sb.append("&code=").append(cleanCode)
        }
        sb.append("&fallback=404&v=7")
        return sb.toString()
    }

    fun productImageUrl(title: String, brand: String = "", code: String = ""): String {
        val cleanBrand = sanitizeApiBrand(brand)
        val lookupTitle = if (cleanBrand.isNotBlank() && !title.contains(cleanBrand, ignoreCase = true)) {
            "$cleanBrand ${title.trim()}"
        } else {
            title
        }
        return verifiedDirectImageUrl(lookupTitle) ?: productImageApiFallbackUrl(title, cleanBrand, code)
    }

    fun resolveBestImageUrl(title: String, rawImageUrl: String, brand: String = "", code: String = ""): String {
        val cleanBrand = sanitizeApiBrand(brand)
        val cleanCode = code.filter { it.isDigit() }.take(14)
        var normalized = rawImageUrl.trim()
        if (normalized.equals("null", ignoreCase = true)) {
            normalized = ""
        }
        if (normalized.startsWith("http://", ignoreCase = true)) {
            normalized = "https://" + normalized.substring(7)
        } else if (normalized.startsWith("/api/product-image") || normalized.startsWith("/swaps/")) {
            normalized = "https://www.heybroc.com$normalized"
        }
        if (normalized.contains("/api/product-image")) {
            // Re-canonicalize /api/product-image URLs through productImageApiFallbackUrl so legacy
            // Category-Estimate &brand=... query params or non-food queries are cleaned up automatically.
            val lookupForApi = if (cleanBrand.isNotBlank() && !title.contains(cleanBrand, ignoreCase = true)) {
                "$cleanBrand ${title.trim()}"
            } else {
                title
            }
            return verifiedDirectImageUrl(lookupForApi) ?: productImageApiFallbackUrl(title, cleanBrand, cleanCode)
        }
        val isLegacyLocalBrandPackshot =
            normalized.contains("heybroc.com/products/", ignoreCase = true) ||
                normalized.contains("cleancart-teal.vercel.app/products/", ignoreCase = true) ||
                normalized.startsWith("/products/")
        val hasDisallowedForeignFront = NON_US_FOREIGN_OFF_FRONT_TOKENS.any { tok ->
            normalized.contains(tok, ignoreCase = true)
        }
        if (
            normalized.startsWith("https://") &&
            !normalized.contains("product-photo-unavailable", ignoreCase = true) &&
            !isLegacyLocalBrandPackshot &&
            !hasDisallowedForeignFront &&
            !REVOKED_OFF_IMAGE_RE.containsMatchIn(normalized)
        ) {
            // Never short-circuit primary photo resolution on category studio art (/swaps/*);
            // try a verified direct OFF photo or /api/product-image?...&fallback=404 first so
            // categoryArtUrl remains the post-404 fallback with its "Illustration" badge.
            if (isCategoryArtUrl(normalized)) {
                val lookupForArt = if (cleanBrand.isNotBlank() && !title.contains(cleanBrand, ignoreCase = true)) {
                    "$cleanBrand ${title.trim()}"
                } else {
                    title
                }
                return verifiedDirectImageUrl(lookupForArt) ?: productImageApiFallbackUrl(title, cleanBrand, cleanCode)
            }
            return normalized
        }

        val lookupTitle = if (cleanBrand.isNotBlank() && !title.contains(cleanBrand, ignoreCase = true)) {
            "$cleanBrand ${title.trim()}"
        } else {
            title
        }
        return verifiedDirectImageUrl(lookupTitle) ?: productImageApiFallbackUrl(title, cleanBrand, cleanCode)
    }

    private fun parseList(raw: String): List<JSONObject> = runCatching {
        val arr = JSONArray(raw)
        val out = ArrayList<JSONObject>(arr.length())
        val seenKeys = HashSet<String>()
        val now = System.currentTimeMillis()
        for (i in 0 until arr.length()) {
            val item = arr.optJSONObject(i) ?: continue
            item.remove("storeImageUrl")
            val ts = item.optLong("scannedAtMs", 0L).takeIf { it > 0L } ?: item.optLong("favoritedAtMs", 0L)
            if (!isEntryFresh(ts, now)) continue
            val lookupObj = item.optJSONObject("lookup")
            val verifiedIso = lookupObj?.optString("verifiedAt").orEmpty()
                .ifBlank { lookupObj?.optString("sourceUpdatedAt").orEmpty() }
            if (verifiedIso.isNotBlank() && !isCatalogDateFresh(verifiedIso, now)) continue
            val rawTitle = extractTitle(item)
            if (isPoisonedProduceEntry(rawTitle, item)) continue
            val key = canonicalKey(rawTitle)
            if (key.isBlank() || !seenKeys.add(key)) continue
            item.optJSONObject("product")?.let { prod ->
                prod.remove("storeImageUrl")
                val curImg = prod.optString("imageUrl")
                val prodBrand = prod.optString("brand")
                val prodCat = prod.optString("category").ifBlank { item.optString("category") }
                val prodIng = prod.optString("ingredients")
                val prodBarcode = prod.optString("barcode").ifBlank { lookupObj?.optString("barcode").orEmpty() }
                val catArt = normalizeCategoryArtUrl(prod.optString("categoryArtUrl"))
                    .ifBlank { if (isCategoryArtUrl(curImg)) normalizeCategoryArtUrl(curImg) else "" }
                    .ifBlank { resolveCategoryStudioArt(rawTitle, prodCat, prodIng) }
                if (catArt.isNotEmpty()) {
                    prod.put("categoryArtUrl", catArt)
                }
                prod.put("imageUrl", resolveBestImageUrl(rawTitle, curImg, prodBrand, prodBarcode))
            }
            val itemStore = item.optString("storeKey", "walmart").ifBlank { "walmart" }
            item.optJSONObject("swap")?.let { sw ->
                upgradeSwapForStore(sw, rawTitle, itemStore)
                val swTitle = sw.optString("title")
                val swBrand = sw.optString("brand")
                val swBarcode = sw.optString("barcode")
                val swIng = sw.optString("ingredients")
                if (swTitle.isNotBlank()) {
                    val rawSwImg = sw.optString("imageUrl").ifBlank { sw.optString("image") }
                    val swCatArt = normalizeCategoryArtUrl(sw.optString("categoryArtUrl"))
                        .ifBlank { if (isCategoryArtUrl(rawSwImg)) normalizeCategoryArtUrl(rawSwImg) else "" }
                        .ifBlank { resolveCategoryStudioArt(swTitle, "", swIng) }
                    if (swCatArt.isNotEmpty()) {
                        sw.put("categoryArtUrl", swCatArt)
                    }
                    sw.put("imageUrl", resolveBestImageUrl(swTitle, rawSwImg, swBrand, swBarcode))
                }
            }
            item.optJSONObject("storeSwapLink")?.let { sw ->
                val desc = item.optJSONObject("product")?.optString("description").orEmpty()
                upgradeSwapForStore(sw, "$rawTitle $desc", itemStore)
            }
            out.add(item)
        }
        out
    }.getOrDefault(emptyList())

    /**
     * Instant 0ms on-device prefix/token matcher across user History, Favorites, and Explore catalog
     * for GPS-style live autocomplete while typing.
     */
    fun localSuggestions(context: Context, rawQuery: String, limit: Int = 6): List<JSONObject> {
        val q = rawQuery.trim().lowercase()
        if (q.isEmpty()) return emptyList()
        val tokens = q.split(Regex("[^a-z0-9]+")).filter { it.isNotBlank() }
        if (tokens.isEmpty()) return emptyList()
        val pool = LinkedHashMap<String, JSONObject>()
        (getHistory(context) + getFavorites(context) + getExploreCatalog(context)).forEach { item ->
            val t = extractTitle(item)
            val k = normKey(t)
            if (k.isNotBlank() && !pool.containsKey(k)) {
                pool[k] = item
            }
        }
        val scored = mutableListOf<Pair<Int, JSONObject>>()
        for ((_, item) in pool) {
            val prod = item.optJSONObject("product")
            val title = extractTitle(item)
            if (!passesVariantGuard(rawQuery, title)) continue
            val brand = prod?.optString("brand").orEmpty()
            val cat = prod?.optString("category").orEmpty().ifBlank { item.optString("category") }
            val kw = prod?.optString("keywords").orEmpty()
            val hayWords = "$brand $title $cat $kw".lowercase().split(Regex("[^a-z0-9]+")).filter { it.isNotBlank() }
            val titleLow = title.lowercase()
            val brandLow = brand.lowercase()

            val allTokensMatch = tokens.all { tok ->
                hayWords.any { w -> w.startsWith(tok) || (tok.length >= 4 && w.contains(tok)) }
            }
            val score = when {
                titleLow.startsWith(q) || brandLow.startsWith(q) -> 100
                allTokensMatch && hayWords.any { it == tokens[0] } -> 90
                allTokensMatch -> 78
                else -> 0
            }
            if (score > 0) scored.add(score to item)
        }
        return scored.sortedByDescending { it.first }.take(limit).map { it.second }
    }

    /**
     * Built-in starter products in the exact `/api/scan` format so My Scans, Clean Swaps,
     * Top Picks (by category), and Search feel rich immediately upon install.
     */
    val EXPLORE_CATALOG: List<JSONObject> by lazy {
        listOf(
            sampleItem(
                title = "Hidden Valley Original Ranch Salad Dressing",
                brand = "Hidden Valley",
                category = "Salads & Dressings",
                score = 12,
                rating = "Poor",
                color = "red",
                imageUrl = productImageUrl("Hidden Valley Original Ranch Salad Dressing"),
                ingredients = "Vegetable Oil (Soybean and/or Canola), Water, Sugar, Salt, Buttermilk, Egg Yolk, Natural Flavors, Phosphoric Acid, Xanthan Gum, Monosodium Glutamate, Artificial Flavors, Disodium Phosphate, Sorbic Acid, Calcium Disodium EDTA.",
                flagged = listOf(
                    FlagInfo("Calcium Disodium EDTA", 25, "high", "Synthetic chelating preservative flagged on our clean-label watchlist."),
                    FlagInfo("Soybean Oil", 15, "moderate", "Refined industrial seed oil flagged on our clean-label watchlist."),
                    FlagInfo("Canola Oil", 15, "moderate", "Refined industrial seed oil flagged on our clean-label watchlist."),
                    FlagInfo("Monosodium Glutamate (MSG)", 15, "moderate", "Synthetic flavor enhancer."),
                    FlagInfo("Artificial Flavors", 15, "moderate", "Lab-synthesized flavor chemicals.")
                ),
                nutritionScore = 12,
                nutriGrade = "E",
                additiveScore = 0,
                organicScore = 0,
                swap = swapObj(
                    "Primal Kitchen Avocado Oil Ranch Dressing",
                    "Primal Kitchen",
                    90,
                    productImageUrl("Primal Kitchen Avocado Oil Ranch Dressing"),
                    "Avocado Oil, Water, Organic Vinegar, Organic Cage-Free Eggs, Organic Lemon Juice, Salt, Organic Dill, Organic Garlic, Organic Onion."
                )
            ),
            sampleItem(
                title = "Marketside Organic Baby Spinach & Romaine Salad Blend",
                brand = "Marketside Organic",
                category = "Salads & Dressings",
                score = 100,
                rating = "Excellent",
                color = "green",
                imageUrl = productImageUrl("Marketside Organic Baby Spinach Romaine Salad"),
                ingredients = "Organic Romaine Lettuce, Organic Baby Spinach, Organic Red Cabbage, Organic Carrots.",
                flagged = emptyList(),
                nutritionScore = 60,
                nutriGrade = "A",
                additiveScore = 30,
                organicScore = 10,
                swap = null
            ),
            sampleItem(
                title = "General Mills Cinnamon Toast Crunch Cereal",
                brand = "General Mills",
                category = "Cereals & Granolas",
                score = 9,
                rating = "Poor",
                color = "red",
                imageUrl = productImageUrl("General Mills Cinnamon Toast Crunch Cereal"),
                ingredients = "Whole Grain Wheat, Sugar, Rice Flour, Canola and/or Sunflower Oil, Fructose, Maltodextrin, Dextrose, Salt, Cinnamon, Trisodium Phosphate, Soy Lecithin, Rosemary Extract. BHT Added to Preserve Freshness.",
                flagged = listOf(
                    FlagInfo("BHT / BHA", 25, "high", "Synthetic phenolic antioxidant preservative flagged on our clean-label watchlist."),
                    FlagInfo("Canola Oil", 15, "moderate", "Refined industrial seed oil flagged on our clean-label watchlist."),
                    FlagInfo("Sunflower Oil", 15, "moderate", "Refined industrial seed oil flagged on our clean-label watchlist."),
                    FlagInfo("Trisodium Phosphate", 15, "moderate", "Inorganic phosphate additive.")
                ),
                nutritionScore = 24,
                nutriGrade = "D",
                additiveScore = 0,
                organicScore = 0,
                swap = swapObj(
                        "Nature's Path Organic Heritage Flakes Cereal",
                        "Nature's Path",
                        92,
                        productImageUrl("Nature's Path Organic Heritage Flakes Cereal"),
                        "Organic Whole Wheat Meal, Organic Oat Flour, Organic Khorasan Wheat, Organic Barley Flour, Organic Spelt Flour, Organic Millet, Organic Quinoa, Organic Cane Sugar, Sea Salt.",
                        isOrganic = true
                    )
            ),
            sampleItem(
                title = "Marketside New England Clam Chowder, 16 oz",
                brand = "Marketside",
                category = "Soups & Chowders",
                score = 42,
                rating = "Poor",
                color = "red",
                imageUrl = productImageUrl("Marketside New England Clam Chowder 16 oz"),
                ingredients = "Light Cream, Potatoes, Fish Stock, Sea Clams, Chopped Cockle, Onions, Wheat Flour, Soybean Oil, Butter, Clam Broth, Sea Salt, Celery, Salt Pork, Black Pepper, Worcestershire Sauce, Garlic, Natural Flavors.",
                flagged = listOf(
                    FlagInfo("Soybean Oil", 15, "moderate", "Refined industrial seed oil flagged on our clean-label watchlist."),
                    FlagInfo("Natural Flavors", 5, "low", "Proprietary flavor blend that can include solvents and carriers.")
                ),
                nutritionScore = 42,
                nutriGrade = "B",
                additiveScore = 0,
                organicScore = 0,
                swap = swapObj(
                    "Amy's Organic Low Fat Lentil Vegetable Soup",
                    "Amy's Organic",
                    94,
                    productImageUrl("Amy's Organic Lentil Vegetable Soup"),
                    "Filtered Water, Organic Lentils, Organic Carrots, Organic Celery, Organic Potatoes, Organic Extra Virgin Olive Oil, Sea Salt."
                )
            ),
            sampleItem(
                title = "Campbell's New England Clam Chowder Soup",
                brand = "Campbell's",
                category = "Soups & Chowders",
                score = 27,
                rating = "Poor",
                color = "red",
                imageUrl = productImageUrl("Campbell's Chunky New England Clam Chowder Soup"),
                ingredients = "Clam Stock, Potatoes, Clams, Vegetable Oil (Corn, Canola, And/Or Soybean), Celery, Modified Food Starch, Wheat Flour, Salt, Cream, Soy Protein Concentrate, Monosodium Glutamate, Sodium Phosphate, Disodium Inosinate, Disodium Guanylate, Natural Flavoring, Soy Lecithin.",
                flagged = listOf(
                    FlagInfo("Canola Oil", 15, "moderate", "Refined industrial seed oil flagged on our clean-label watchlist."),
                    FlagInfo("Corn Oil", 15, "moderate", "Refined industrial seed oil flagged on our clean-label watchlist."),
                    FlagInfo("Soybean Oil", 15, "moderate", "Refined industrial seed oil flagged on our clean-label watchlist."),
                    FlagInfo("Monosodium Glutamate (MSG)", 15, "moderate", "Synthetic flavor enhancer."),
                    FlagInfo("Sodium Phosphate", 15, "moderate", "Synthetic phosphate additive."),
                    FlagInfo("Soy Lecithin", 6, "low", "Industrial soy emulsifier.")
                ),
                nutritionScore = 27,
                nutriGrade = "C",
                additiveScore = 0,
                organicScore = 0,
                swap = swapObj(
                    "Amy's Organic Low Fat Lentil Vegetable Soup",
                    "Amy's Organic",
                    94,
                    productImageUrl("Amy's Organic Lentil Vegetable Soup"),
                    "Filtered Water, Organic Lentils, Organic Carrots, Organic Celery, Organic Potatoes, Organic Extra Virgin Olive Oil, Sea Salt."
                )
            ),
            sampleItem(
                title = "Doritos Nacho Cheese Tortilla Chips",
                brand = "Doritos",
                category = "Chips & Snacks",
                score = 18,
                rating = "Poor",
                color = "red",
                imageUrl = productImageUrl("Doritos Nacho Cheese Tortilla Chips"),
                ingredients = "Corn, Vegetable Oil (Corn, Canola, and/or Sunflower Oil), Maltodextrin, Salt, Cheddar Cheese, Whey, Monosodium Glutamate, Artificial Color (Yellow 6, Yellow 5, Red 40), Disodium Inosinate, Disodium Guanylate.",
                flagged = listOf(
                    FlagInfo("Red 40", 25, "high", "Petroleum-derived synthetic azo dye flagged on our clean-label watchlist."),
                    FlagInfo("Yellow 5", 25, "high", "Synthetic azo dye requiring warning labels in the EU."),
                    FlagInfo("Yellow 6", 25, "high", "Synthetic azo dye flagged on our clean-label watchlist."),
                    FlagInfo("Canola Oil", 15, "moderate", "Refined industrial seed oil."),
                    FlagInfo("Monosodium Glutamate (MSG)", 15, "moderate", "Synthetic flavor enhancer.")
                ),
                nutritionScore = 18,
                nutriGrade = "D",
                additiveScore = 0,
                organicScore = 0,
                swap = swapObj(
                    "Siete Grain Free Sea Salt Tortilla Chips (Avocado Oil)",
                    "Siete",
                    72,
                    productImageUrl("Siete Grain Free Sea Salt Tortilla Chips"),
                    "Cassava Flour, Avocado Oil, Coconut Flour, Chia Seed, Sea Salt."
                )
            ),
            sampleItem(
                title = "Doritos Cool Ranch Tortilla Chips",
                brand = "Doritos",
                category = "Chips & Snacks",
                score = 18,
                rating = "Poor",
                color = "red",
                imageUrl = productImageUrl("Doritos Cool Ranch Tortilla Chips"),
                ingredients = "Corn, Vegetable Oil (Corn, Canola, and/or Sunflower Oil), Maltodextrin, Salt, Tomato Powder, Lactose, Whey, Monosodium Glutamate, Artificial Color (Red 40, Blue 1, Yellow 5), Disodium Inosinate, Disodium Guanylate.",
                flagged = listOf(
                    FlagInfo("Red 40", 25, "high", "Petroleum-derived synthetic azo dye."),
                    FlagInfo("Blue 1", 25, "high", "Synthetic triphenylmethane dye."),
                    FlagInfo("Yellow 5", 25, "high", "Synthetic azo dye."),
                    FlagInfo("Canola Oil", 15, "moderate", "Refined industrial seed oil."),
                    FlagInfo("Monosodium Glutamate (MSG)", 15, "moderate", "Synthetic flavor enhancer.")
                ),
                nutritionScore = 18,
                nutriGrade = "D",
                additiveScore = 0,
                organicScore = 0,
                swap = swapObj(
                    "Siete Grain Free Sea Salt Tortilla Chips (Avocado Oil)",
                    "Siete",
                    72,
                    productImageUrl("Siete Grain Free Sea Salt Tortilla Chips"),
                    "Cassava Flour, Avocado Oil, Coconut Flour, Chia Seed, Sea Salt."
                )
            ),
            sampleItem(
                title = "Santa Cruz Organic Dark Roasted Peanut Butter",
                brand = "Santa Cruz Organic",
                category = "Peanut Butter",
                score = 96,
                rating = "Excellent",
                color = "green",
                imageUrl = productImageUrl("Santa Cruz Organic Dark Roasted Peanut Butter"),
                ingredients = "Organic Roasted Peanuts, Salt (1% or less).",
                flagged = emptyList(),
                nutritionScore = 56,
                nutriGrade = "A",
                additiveScore = 30,
                organicScore = 10,
                swap = null
            ),
            sampleItem(
                title = "Three Wishes Unsweetened Cocoa Grain-Free Cereal",
                brand = "Three Wishes",
                category = "Cereals & Granolas",
                score = 82,
                rating = "Excellent",
                color = "green",
                imageUrl = productImageUrl("Three Wishes Cocoa Grain Free Cereal"),
                ingredients = "Chickpea, Tapioca, Pea Protein, Organic Cocoa, Monk Fruit, Salt.",
                flagged = emptyList(),
                nutritionScore = 52,
                nutriGrade = "A",
                additiveScore = 30,
                organicScore = 0,
                swap = null
            ),
            sampleItem(
                title = "Organic Valley Pasture-Raised Salted Butter",
                brand = "Organic Valley",
                category = "Milk & Dairy",
                score = 80,
                rating = "Excellent",
                color = "green",
                imageUrl = productImageUrl("Organic Valley Pasture Raised Salted Butter"),
                ingredients = "Organic Pasteurized Sweet Cream, Salt.",
                flagged = emptyList(),
                nutritionScore = 40,
                nutriGrade = "B",
                additiveScore = 30,
                organicScore = 10,
                swap = null
            ),
            sampleItem(
                title = "Lactaid 100% Lactose-Free Fat Free Milk",
                brand = "Lactaid",
                category = "Milk & Dairy",
                score = 90,
                rating = "Excellent",
                color = "green",
                imageUrl = productImageUrl("Lactaid Fat Free Milk"),
                ingredients = "Fat Free Milk, Lactase Enzyme, Vitamin A Palmitate, Vitamin D3.",
                flagged = emptyList(),
                nutritionScore = 60,
                nutriGrade = "A",
                additiveScore = 30,
                organicScore = 0,
                swap = null
            ),
            sampleItem(
                title = "Amy's Organic Low Fat Lentil Vegetable Soup",
                brand = "Amy's",
                category = "Soups & Chowders",
                score = 94,
                rating = "Excellent",
                color = "green",
                imageUrl = productImageUrl("Amy's Organic Lentil Vegetable Soup"),
                ingredients = "Filtered Water, Organic Onions, Organic Green Lentils, Organic Carrots, Organic Celery, Organic Potatoes, Organic Spinach, Organic Extra Virgin Olive Oil, Sea Salt, Organic Garlic, Organic Bay Leaves.",
                flagged = emptyList(),
                nutritionScore = 54,
                nutriGrade = "A",
                additiveScore = 30,
                organicScore = 10,
                swap = null
            ),
            sampleItem(
                title = "Boulder Canyon Avocado Oil Kettle Cooked Potato Chips",
                brand = "Boulder Canyon",
                category = "Chips & Snacks",
                score = 82,
                rating = "Excellent",
                color = "green",
                imageUrl = productImageUrl("Boulder Canyon Avocado Oil Kettle Chips"),
                ingredients = "Potatoes, Avocado Oil, Sea Salt.",
                flagged = emptyList(),
                nutritionScore = 52,
                nutriGrade = "B",
                additiveScore = 30,
                organicScore = 0,
                swap = null
            ),
            sampleItem(
                title = "Dave's Killer Bread Organic 21 Whole Grains & Seeds",
                brand = "Dave's Killer Bread",
                category = "Bread & Bakery",
                score = 90,
                rating = "Excellent",
                color = "green",
                imageUrl = productImageUrl("Dave's Killer Bread Organic 21 Whole Grains"),
                ingredients = "Organic Whole Wheat, Water, Organic Cane Sugar, Organic Cracked Whole Wheat, Organic 21 Whole Grains and Seeds Mix, Organic Vital Wheat Gluten, Organic Oat Fiber, Yeast, Sea Salt.",
                flagged = emptyList(),
                nutritionScore = 50,
                nutriGrade = "A",
                additiveScore = 30,
                organicScore = 10,
                swap = null
            ),
            sampleItem(
                title = "Hu Simple Organic 70% Dark Chocolate Bar",
                brand = "Hu Kitchen",
                category = "Dark Chocolate & Treats",
                score = 92,
                rating = "Excellent",
                color = "green",
                imageUrl = productImageUrl("Hu Simple Organic 70% Dark Chocolate Bar"),
                ingredients = "Organic Fair-Trade Cacao, Unrefined Organic Coconut Sugar, Organic Fair-Trade Cocoa Butter.",
                flagged = emptyList(),
                nutritionScore = 52,
                nutriGrade = "A",
                additiveScore = 30,
                organicScore = 10,
                swap = null
            ),
            // ==================== ENERGY DRINKS & PRE-WORKOUTS ====================
            sampleItem(
                title = "Monster Energy Original Green Energy Drink, 16 fl oz",
                brand = "Monster Energy",
                category = "Energy Drinks & Pre-Workouts",
                score = 6,
                rating = "Poor",
                color = "red",
                imageUrl = productImageUrl("Monster Energy Original Green 16 oz"),
                description = "Carbonated energy drink with 160mg caffeine, 54g added sugar, sucralose, and synthetic preservatives (sorbic & benzoic acid).",
                keywords = "monster energy drink original green monster green 16 oz caffeine taurine",
                ingredients = "Carbonated Water, Sucrose, Glucose, Citric Acid, Natural Flavors, Taurine, Sodium Citrate, Color Added, Panax Ginseng Root Extract, L-Carnitine L-Tartrate, Caffeine, Sorbic Acid (Preservative), Benzoic Acid (Preservative), Niacinamide, Sucralose, Inositol, Pyridoxine Hydrochloride, Riboflavin, Maltodextrin, Cyanocobalamin.",
                flagged = listOf(
                    FlagInfo("Sucralose", 15, "moderate", "Synthetic chlorinated sweetener flagged on our clean-label watchlist."),
                    FlagInfo("Potassium Sorbate / Sorbic Acid", 6, "low", "Synthetic mold and yeast preservative."),
                    FlagInfo("Sodium Benzoate / Benzoic Acid", 15, "moderate", "Synthetic preservative flagged on our clean-label watchlist.")
                ),
                nutritionScore = 0,
                nutriGrade = "E",
                additiveScore = 6,
                organicScore = 0,
                swap = swapObj(
                        "Guayakí Organic Yerba Mate Unsweetened Clean Energy Tea",
                        "Guayakí",
                        90,
                        productImageUrl("Guayaki Organic Yerba Mate Tea"),
                        "Purified Water, Organic Brewed Yerba Mate, Organic Lemon Juice.",
                        isOrganic = true
                    )
            ),
            sampleItem(
                title = "Monster Energy Zero Ultra White Energy Drink, 16 fl oz",
                brand = "Monster Energy",
                category = "Energy Drinks & Pre-Workouts",
                score = 42,
                rating = "Poor",
                color = "red",
                imageUrl = productImageUrl("Monster Energy Zero Ultra White 16 oz"),
                description = "Zero-sugar carbonated energy drink (150mg caffeine) sweetened with erythritol, sucralose, and acesulfame potassium.",
                keywords = "monster zero ultra white monster sugar free energy drink monster white",
                ingredients = "Carbonated Water, Citric Acid, Erythritol, Taurine, Sodium Citrate, Panax Ginseng Flavor, L-Carnitine L-Tartrate, Caffeine, Sorbic Acid (Preservative), Sucralose, Benzoic Acid (Preservative), Niacinamide, Acesulfame Potassium, Natural Flavors, Inositol, Pyridoxine Hydrochloride, Cyanocobalamin.",
                flagged = listOf(
                    FlagInfo("Sucralose", 15, "moderate", "Synthetic chlorinated sweetener."),
                    FlagInfo("Acesulfame Potassium (Ace-K)", 15, "moderate", "Synthetic high-intensity sweetener."),
                    FlagInfo("Sodium Benzoate / Benzoic Acid", 15, "moderate", "Synthetic preservative."),
                    FlagInfo("Potassium Sorbate / Sorbic Acid", 6, "low", "Synthetic preservative.")
                ),
                nutritionScore = 36,
                nutriGrade = "C",
                additiveScore = 6,
                organicScore = 0,
                swap = swapObj(
                        "Guayakí Organic Yerba Mate Unsweetened Clean Energy Tea",
                        "Guayakí",
                        90,
                        productImageUrl("Guayaki Organic Yerba Mate Tea"),
                        "Purified Water, Organic Brewed Yerba Mate, Organic Lemon Juice.",
                        isOrganic = true
                    )
            ),
            sampleItem(
                title = "Red Bull Energy Drink Original, 8.4 fl oz",
                brand = "Red Bull",
                category = "Energy Drinks & Pre-Workouts",
                score = 30,
                rating = "Poor",
                color = "red",
                imageUrl = productImageUrl("Red Bull Energy Drink Original 8.4 oz"),
                description = "Classic Austrian energy drink with 80mg caffeine, 1000mg taurine, B-group vitamins, and 27g added sugars per 8.4 fl oz can.",
                keywords = "red bull redbull energy drink original 8.4 oz 12 oz taurine caffeine",
                ingredients = "Carbonated Water, Sucrose, Glucose, Citric Acid, Taurine, Sodium Bicarbonate, Magnesium Carbonate, Caffeine, Niacinamide, Calcium Pantothenate, Pyridoxine HCl, Vitamin B12, Natural and Artificial Flavors, Colors.",
                flagged = emptyList(),
                nutritionScore = 0,
                nutriGrade = "E",
                additiveScore = 30,
                organicScore = 0,
                swap = swapObj(
                        "Guayakí Organic Yerba Mate Unsweetened Clean Energy Tea",
                        "Guayakí",
                        90,
                        productImageUrl("Guayaki Organic Yerba Mate Tea"),
                        "Purified Water, Organic Brewed Yerba Mate, Organic Lemon Juice.",
                        isOrganic = true
                    )
            ),
            sampleItem(
                title = "Red Bull Sugarfree Energy Drink, 8.4 fl oz",
                brand = "Red Bull",
                category = "Energy Drinks & Pre-Workouts",
                score = 42,
                rating = "Poor",
                color = "red",
                imageUrl = productImageUrl("Red Bull Sugarfree Energy Drink 8.4 oz"),
                description = "Zero-sugar Red Bull with 80mg caffeine and taurine, sweetened with aspartame and acesulfame potassium (Ace-K).",
                keywords = "red bull sugarfree sugar free redbull diet zero sugar energy drink",
                ingredients = "Carbonated Water, Citric Acid, Taurine, Sodium Bicarbonate, Magnesium Carbonate, Caffeine, Acesulfame K, Aspartame, Niacinamide, Calcium Pantothenate, Pyridoxine HCl, Vitamin B12, Xanthan Gum, Natural and Artificial Flavors, Colors.",
                flagged = listOf(
                    FlagInfo("Aspartame", 15, "moderate", "Artificial sweetener classified by IARC as Group 2B."),
                    FlagInfo("Acesulfame Potassium (Ace-K)", 15, "moderate", "Synthetic high-intensity sweetener.")
                ),
                nutritionScore = 36,
                nutriGrade = "C",
                additiveScore = 6,
                organicScore = 0,
                swap = swapObj(
                        "Guayakí Organic Yerba Mate Unsweetened Clean Energy Tea",
                        "Guayakí",
                        90,
                        productImageUrl("Guayaki Organic Yerba Mate Tea"),
                        "Purified Water, Organic Brewed Yerba Mate, Organic Lemon Juice.",
                        isOrganic = true
                    )
            ),
            sampleItem(
                title = "Celsius Live Fit Sparkling Orange Fitness Energy Drink, 12 fl oz",
                brand = "Celsius",
                category = "Energy Drinks & Pre-Workouts",
                score = 51,
                rating = "Mediocre",
                color = "yellow",
                imageUrl = productImageUrl("Celsius Live Fit Sparkling Orange Energy Drink"),
                description = "Zero-sugar thermogenic fitness energy drink with 200mg caffeine from green tea & guarana, sweetened with sucralose.",
                keywords = "celsius energy drink live fit sparkling orange peach vibe arctic vibe fitness",
                ingredients = "Filtered Carbonated Water, Citric Acid, Taurine, Guarana Seed Extract, Green Tea Extract, Caffeine, Ascorbic Acid, Glucuronolactone, Ginger Root Extract, Calcium Carbonate, Sucralose, Beta-Carotene (for Color), Natural Flavor, Niacinamide, Pyridoxine Hydrochloride, Biotin, Cyanocobalamin.",
                flagged = listOf(
                    FlagInfo("Sucralose", 15, "moderate", "Synthetic chlorinated sweetener.")
                ),
                nutritionScore = 36,
                nutriGrade = "C",
                additiveScore = 15,
                organicScore = 0,
                swap = swapObj(
                        "Guayakí Organic Yerba Mate Unsweetened Clean Energy Tea",
                        "Guayakí",
                        90,
                        productImageUrl("Guayaki Organic Yerba Mate Tea"),
                        "Purified Water, Organic Brewed Yerba Mate, Organic Lemon Juice.",
                        isOrganic = true
                    )
            ),
            sampleItem(
                title = "C4 Performance Energy Drink Frozen Bombsicle, 16 fl oz",
                brand = "C4 Energy",
                category = "Energy Drinks & Pre-Workouts",
                score = 42,
                rating = "Poor",
                color = "red",
                imageUrl = productImageUrl("C4 Performance Energy Frozen Bombsicle 16 oz"),
                description = "Pre-workout carbonated energy drink with 200mg caffeine, CarnoSyn beta-alanine, and citrulline, sweetened with sucralose & Ace-K.",
                keywords = "c4 energy drink pre workout preworkout frozen bombsicle skittles starburst cellucor",
                ingredients = "Carbonated Water, CarnoSyn Beta-Alanine, L-Citrulline, Malic Acid, Betaine Anhydrous, Citric Acid, Natural Flavors, Caffeine Anhydrous, Sucralose, Potassium Sorbate (Preservative), Acesulfame Potassium, Niacinamide, Cyanocobalamin.",
                flagged = listOf(
                    FlagInfo("Sucralose", 15, "moderate", "Synthetic chlorinated sweetener."),
                    FlagInfo("Acesulfame Potassium (Ace-K)", 15, "moderate", "Synthetic high-intensity sweetener."),
                    FlagInfo("Potassium Sorbate", 6, "low", "Synthetic preservative.")
                ),
                nutritionScore = 36,
                nutriGrade = "C",
                additiveScore = 6,
                organicScore = 0,
                swap = swapObj(
                        "Ora Organic Renewable Energy Clean Pre-Workout",
                        "Ora Organic",
                        90,
                        productImageUrl("Ora Organic Renewable Energy Pre Workout"),
                        "Organic Green Coffee Bean, Organic Yerba Mate, Organic Matcha, Organic Beet Root, Organic Maca Root, Organic Stevia.",
                        isOrganic = true
                    )
            ),
            sampleItem(
                title = "C4 Original Pre-Workout Powder Icy Blue Razz",
                brand = "Cellucor C4",
                category = "Energy Drinks & Pre-Workouts",
                score = 42,
                rating = "Poor",
                color = "red",
                imageUrl = productImageUrl("C4 Original Pre Workout Powder Icy Blue Razz"),
                description = "Explosive pre-workout supplement powder with 150mg caffeine, 1.6g beta-alanine, and 1g creatine nitrate; contains Blue 1, sucralose, and Ace-K.",
                keywords = "c4 pre workout preworkout powder cellucor icy blue razz fruit punch",
                ingredients = "CarnoSyn Beta-Alanine, Creatine Nitrate, Arginine Alpha-Ketoglutarate, Citric Acid, Polydextrose, Malic Acid, Natural and Artificial Flavors, Calcium Silicate, Silicon Dioxide, Sucralose, Acesulfame Potassium, Caffeine Anhydrous, FD&C Blue #1.",
                flagged = listOf(
                    FlagInfo("Blue 1", 25, "high", "Synthetic triphenylmethane dye."),
                    FlagInfo("Sucralose", 15, "moderate", "Synthetic chlorinated sweetener."),
                    FlagInfo("Acesulfame Potassium (Ace-K)", 15, "moderate", "Synthetic high-intensity sweetener.")
                ),
                nutritionScore = 36,
                nutriGrade = "C",
                additiveScore = 6,
                organicScore = 0,
                swap = swapObj(
                        "Ora Organic Renewable Energy Clean Pre-Workout",
                        "Ora Organic",
                        90,
                        productImageUrl("Ora Organic Renewable Energy Pre Workout"),
                        "Organic Green Coffee Bean, Organic Yerba Mate, Organic Matcha, Organic Beet Root, Organic Maca Root, Organic Stevia.",
                        isOrganic = true
                    )
            ),
            sampleItem(
                title = "Alani Nu Energy Drink Cosmic Stardust, 12 fl oz",
                brand = "Alani Nu",
                category = "Energy Drinks & Pre-Workouts",
                score = 42,
                rating = "Poor",
                color = "red",
                imageUrl = productImageUrl("Alani Nu Energy Drink Cosmic Stardust 12 oz"),
                description = "Zero-sugar energy drink with 200mg caffeine, L-theanine, and biotin, sweetened with erythritol, sucralose, and Ace-K.",
                keywords = "alani nu energy drink cosmic stardust cherry slush breezeberry",
                ingredients = "Carbonated Water, Citric Acid, Taurine, Natural Flavor, Erythritol, Sodium Citrate, L-Theanine, Caffeine, Sucralose, Panax Ginseng Root Extract, Sodium Benzoate (Preservative), Potassium Sorbate (Preservative), Acesulfame Potassium, L-Carnitine Tartrate, D-Biotin.",
                flagged = listOf(
                    FlagInfo("Sucralose", 15, "moderate", "Synthetic chlorinated sweetener."),
                    FlagInfo("Acesulfame Potassium (Ace-K)", 15, "moderate", "Synthetic high-intensity sweetener."),
                    FlagInfo("Sodium Benzoate", 15, "moderate", "Synthetic preservative.")
                ),
                nutritionScore = 36,
                nutriGrade = "C",
                additiveScore = 6,
                organicScore = 0,
                swap = swapObj(
                        "Guayakí Organic Yerba Mate Unsweetened Clean Energy Tea",
                        "Guayakí",
                        90,
                        productImageUrl("Guayaki Organic Yerba Mate Tea"),
                        "Purified Water, Organic Brewed Yerba Mate, Organic Lemon Juice.",
                        isOrganic = true
                    )
            ),
            sampleItem(
                title = "Ghost Energy Drink Sour Patch Kids Redberry, 16 fl oz",
                brand = "Ghost",
                category = "Energy Drinks & Pre-Workouts",
                score = 42,
                rating = "Poor",
                color = "red",
                imageUrl = productImageUrl("Ghost Energy Drink Sour Patch Kids Redberry 16 oz"),
                description = "Nootropic zero-sugar energy drink with 200mg natural caffeine, Alpha-GPC, and L-carnitine; sweetened with sucralose & Ace-K.",
                keywords = "ghost energy drink sour patch kids swedish fish warheads nootropic",
                ingredients = "Carbonated Water, Citric Acid, Acetyl-L-Carnitine HCl, Taurine, Natural and Artificial Flavor, Tartaric Acid, Alpha-GPC, Natural Caffeine (from Coffee Bean), Sucralose, Acesulfame Potassium, Sodium Benzoate (Preservative), Potassium Sorbate (Preservative).",
                flagged = listOf(
                    FlagInfo("Sucralose", 15, "moderate", "Synthetic chlorinated sweetener."),
                    FlagInfo("Acesulfame Potassium (Ace-K)", 15, "moderate", "Synthetic high-intensity sweetener."),
                    FlagInfo("Sodium Benzoate", 15, "moderate", "Synthetic preservative.")
                ),
                nutritionScore = 36,
                nutriGrade = "C",
                additiveScore = 6,
                organicScore = 0,
                swap = swapObj(
                        "Guayakí Organic Yerba Mate Unsweetened Clean Energy Tea",
                        "Guayakí",
                        90,
                        productImageUrl("Guayaki Organic Yerba Mate Tea"),
                        "Purified Water, Organic Brewed Yerba Mate, Organic Lemon Juice.",
                        isOrganic = true
                    )
            ),
            sampleItem(
                title = "Guayakí Organic Yerba Mate Unsweetened Clean Energy Tea, 15.5 fl oz",
                brand = "Guayakí",
                category = "Energy Drinks & Pre-Workouts",
                score = 100,
                rating = "Excellent",
                color = "green",
                imageUrl = productImageUrl("Guayaki Organic Yerba Mate Clean Energy Tea"),
                description = "USDA Organic brewed yerba mate delivering 150mg clean plant caffeine with zero artificial sweeteners, dyes, or synthetic preservatives.",
                keywords = "guayaki yerba mate organic energy tea clean energy drink",
                ingredients = "Purified Water, Organic Brewed Yerba Mate (Water, Organic Yerba Mate), Organic Lemon Juice.",
                flagged = emptyList(),
                nutritionScore = 60,
                nutriGrade = "A",
                additiveScore = 30,
                organicScore = 10,
                swap = null
            ),
            sampleItem(
                title = "Ora Organic Renewable Energy Clean Pre-Workout Powder, Beet & Pomegranate",
                brand = "Ora Organic",
                category = "Energy Drinks & Pre-Workouts",
                score = 100,
                rating = "Excellent",
                color = "green",
                imageUrl = productImageUrl("Ora Organic Renewable Energy Pre Workout Powder"),
                description = "USDA Organic plant-based pre-workout with 90mg caffeine from organic green coffee bean, matcha & yerba mate, nitric oxide beet root, and adaptogens.",
                keywords = "ora organic pre workout preworkout clean preworkout beet root",
                ingredients = "Organic Pomegranate Juice Powder, Organic Beet Root Powder, Organic Coconut Water, Organic Green Coffee Bean Extract, Organic Yerba Mate Extract, Organic Matcha Green Tea, Organic Eleuthero Root, Organic Ginseng Root, Organic Stevia Leaf Extract.",
                flagged = emptyList(),
                nutritionScore = 60,
                nutriGrade = "A",
                additiveScore = 30,
                organicScore = 10,
                swap = null
            ),
            sampleItem(
                title = "Core Power Fairlife 26g Protein Milk Shake, Chocolate, 14 fl oz",
                brand = "Core Power by Fairlife",
                category = "Energy Drinks & Pre-Workouts",
                score = 42,
                rating = "Poor",
                color = "red",
                imageUrl = productImageUrl("Core Power Fairlife 26g Protein Milk Shake Chocolate"),
                description = "Ready-to-drink post-workout protein recovery shake made from ultra-filtered milk (26g protein); contains carrageenan, sucralose, and Ace-K.",
                keywords = "core power fairlife protein shake chocolate 26g 42g elite muscle milk",
                ingredients = "Filtered Lowfat Grade A Milk, Alkalized Cocoa, Natural Flavors, Lactase Enzyme, Acesulfame Potassium, Carrageenan, Cellulose Gel, Cellulose Gum, Monk Fruit Juice Concentrate, Salt, Stevia Leaf Extract, Sucralose, Vitamin A Palmitate, Vitamin D3.",
                flagged = listOf(
                    FlagInfo("Carrageenan", 25, "high", "Seaweed-derived thickener flagged on our clean-label watchlist."),
                    FlagInfo("Sucralose", 15, "moderate", "Synthetic chlorinated sweetener."),
                    FlagInfo("Acesulfame Potassium (Ace-K)", 15, "moderate", "Synthetic high-intensity sweetener.")
                ),
                nutritionScore = 36,
                nutriGrade = "C",
                additiveScore = 6,
                organicScore = 0,
                swap = swapObj(
                        "Orgain Organic Grass-Fed Clean Protein Shake",
                        "Orgain",
                        88,
                        productImageUrl("Orgain Organic Grass Fed Protein Shake"),
                        "Filtered Water, Orgain Organic Milk Protein Concentrate (Grass-Fed), Organic Erythritol, Organic Alkalized Cocoa, Organic Acacia, Organic Stevia.",
                        isOrganic = true
                    )
            ),
            // ==================== SODAS & PREBIOTIC DRINKS ====================
            sampleItem(
                title = "Coca-Cola Original Classic Soda, 12 fl oz Can",
                brand = "Coca-Cola",
                category = "Sodas & Prebiotic Drinks",
                score = 6,
                rating = "Poor",
                color = "red",
                imageUrl = productImageUrl("Coca Cola Classic Soda 12 oz Can"),
                description = "Classic cola soft drink sweetened with 39g high fructose corn syrup and colored with Class IV Caramel Color.",
                keywords = "coca cola coke classic soda pop soft drink 12 oz",
                ingredients = "Carbonated Water, High Fructose Corn Syrup, Caramel Color, Phosphoric Acid, Natural Flavors, Caffeine.",
                flagged = listOf(
                    FlagInfo("High-Fructose Corn Syrup", 15, "moderate", "Industrial liquid corn sweetener flagged on our clean-label watchlist."),
                    FlagInfo("Caramel Color (Class III/IV)", 15, "moderate", "Ammonia-sulfite caramel coloring that may carry 4-MEI.")
                ),
                nutritionScore = 0,
                nutriGrade = "E",
                additiveScore = 6,
                organicScore = 0,
                swap = swapObj(
                    "OLIPOP Vintage Cola Prebiotic Soda",
                    "OLIPOP",
                    90,
                    productImageUrl("OLIPOP Vintage Cola Prebiotic Soda"),
                    "Carbonated Water, OLISMART Prebiotic Botanical Blend (Cassava Root Fiber, Chicory Root Inulin, Jerusalem Artichoke Inulin, Nopal Cactus, Marshmallow Root), Apple Juice Concentrate, Cinnamon, Stevia Leaf."
                )
            ),
            sampleItem(
                title = "Diet Coke Zero Calorie Cola Soda, 12 fl oz Can",
                brand = "Coca-Cola",
                category = "Sodas & Prebiotic Drinks",
                score = 42,
                rating = "Poor",
                color = "red",
                imageUrl = productImageUrl("Diet Coke Soda 12 oz Can"),
                description = "Zero-calorie diet cola sweetened with aspartame, colored with Caramel Color, and preserved with potassium benzoate.",
                keywords = "diet coke coca cola zero sugar diet soda aspartame",
                ingredients = "Carbonated Water, Caramel Color, Aspartame, Phosphoric Acid, Potassium Benzoate (to Protect Taste), Natural Flavors, Citric Acid, Caffeine.",
                flagged = listOf(
                    FlagInfo("Aspartame", 15, "moderate", "Artificial sweetener classified by IARC as Group 2B."),
                    FlagInfo("Caramel Color (Class III/IV)", 15, "moderate", "Ammonia-sulfite caramel coloring."),
                    FlagInfo("Sodium/Potassium Benzoate", 15, "moderate", "Synthetic preservative.")
                ),
                nutritionScore = 36,
                nutriGrade = "C",
                additiveScore = 6,
                organicScore = 0,
                swap = swapObj(
                    "OLIPOP Vintage Cola Prebiotic Soda",
                    "OLIPOP",
                    90,
                    productImageUrl("OLIPOP Vintage Cola Prebiotic Soda"),
                    "Carbonated Water, OLISMART Prebiotic Botanical Blend, Apple Juice Concentrate, Cinnamon, Stevia Leaf."
                )
            ),
            sampleItem(
                title = "Mountain Dew Original Citrus Soda, 12 fl oz Can",
                brand = "Mountain Dew",
                category = "Sodas & Prebiotic Drinks",
                score = 6,
                rating = "Poor",
                color = "red",
                imageUrl = productImageUrl("Mountain Dew Citrus Soda 12 oz Can"),
                description = "Caffeinated citrus soft drink with 46g high fructose corn syrup, Yellow 5 synthetic dye, sodium benzoate, and calcium disodium EDTA.",
                keywords = "mountain dew mtn dew citrus soda baja blast code red",
                ingredients = "Carbonated Water, High Fructose Corn Syrup, Concentrated Orange Juice, Citric Acid, Natural Flavor, Sodium Benzoate (Preserves Freshness), Caffeine, Sodium Citrate, Gum Arabic, Erythorbic Acid, Calcium Disodium EDTA, Yellow 5.",
                flagged = listOf(
                    FlagInfo("Yellow 5", 25, "high", "Synthetic azo dye requiring warning labels in the EU."),
                    FlagInfo("High-Fructose Corn Syrup", 15, "moderate", "Industrial liquid sweetener."),
                    FlagInfo("Sodium Benzoate", 15, "moderate", "Synthetic preservative.")
                ),
                nutritionScore = 0,
                nutriGrade = "E",
                additiveScore = 6,
                organicScore = 0,
                swap = swapObj(
                    "Spindrift Organic Sparkling Water with Real Squeezed Fruit",
                    "Spindrift",
                    94,
                    productImageUrl("Spindrift Sparkling Water Lemon Lime"),
                    "Carbonated Water, Real Squeezed Lemon and Lime Juice."
                )
            ),
            sampleItem(
                title = "OLIPOP Vintage Cola Prebiotic Soda, 12 fl oz Can",
                brand = "OLIPOP",
                category = "Sodas & Prebiotic Drinks",
                score = 90,
                rating = "Excellent",
                color = "green",
                imageUrl = productImageUrl("OLIPOP Vintage Cola Prebiotic Soda 12 oz"),
                description = "Gut-healthy prebiotic soda with 9g plant fiber from cassava root, chicory inulin & botanicals, and only 2g sugar with no artificial sweeteners.",
                keywords = "olipop vintage cola prebiotic soda root beer cream soda",
                ingredients = "Carbonated Water, OLISMART (Cassava Root Fiber, Chicory Root Inulin, Jerusalem Artichoke Inulin, Nopal Cactus, Marshmallow Root, Calendula Flower, Kudzu Root), Cassava Root Syrup, Apple Juice Concentrate, Lime Juice, Vinegar, Caramel, Himalayan Pink Salt, Green Tea Caffeine, Stevia Leaf, Cinnamon, Vanilla Bean.",
                flagged = emptyList(),
                nutritionScore = 60,
                nutriGrade = "A",
                additiveScore = 30,
                organicScore = 0,
                swap = null
            ),
            sampleItem(
                title = "Poppi Strawberry Lemon Prebiotic Soda, 12 fl oz Can",
                brand = "Poppi",
                category = "Sodas & Prebiotic Drinks",
                score = 90,
                rating = "Excellent",
                color = "green",
                imageUrl = productImageUrl("Poppi Strawberry Lemon Prebiotic Soda 12 oz"),
                description = "Sparkling prebiotic soda made with unfiltered apple cider vinegar, organic agave inulin fiber, real fruit juice, and stevia.",
                keywords = "poppi prebiotic soda strawberry lemon orange raspberry rose",
                ingredients = "Sparkling Water, Organic Cane Sugar, Apple Cider Vinegar, Organic Agave Inulin, Strawberry Juice, Lemon Juice, Natural Flavors, Fruit and Vegetable Juice (for Color), Stevia.",
                flagged = emptyList(),
                nutritionScore = 60,
                nutriGrade = "A",
                additiveScore = 30,
                organicScore = 0,
                swap = null
            ),
            // ==================== WATERS, SELTZERS & HYDRATION ====================
            sampleItem(
                title = "FIJI Natural Artesian Water, 16.9 fl oz Bottle",
                brand = "FIJI Water",
                category = "Waters, Seltzers & Hydration",
                score = 90,
                rating = "Excellent",
                color = "green",
                imageUrl = productImageUrl("FIJI Natural Artesian Water Bottle"),
                description = "Natural artesian aquifer water bottled at the source in Viti Levu, Fiji, with naturally occurring silica and electrolytes.",
                keywords = "fiji water natural artesian bottled water spring water",
                ingredients = "Natural Artesian Water.",
                flagged = emptyList(),
                nutritionScore = 60,
                nutriGrade = "A",
                additiveScore = 30,
                organicScore = 0,
                swap = null
            ),
            sampleItem(
                title = "Spindrift Sparkling Water with Real Squeezed Raspberry Lime, 12 fl oz",
                brand = "Spindrift",
                category = "Waters, Seltzers & Hydration",
                score = 90,
                rating = "Excellent",
                color = "green",
                imageUrl = productImageUrl("Spindrift Sparkling Water Raspberry Lime"),
                description = "Sparkling water made with only carbonated water and real squeezed fruit puree/juice — zero synthetic 'natural flavors' or sweeteners.",
                keywords = "spindrift sparkling water seltzer raspberry lime lemon pink lemonade",
                ingredients = "Carbonated Water, Raspberry Puree, Lime Juice.",
                flagged = emptyList(),
                nutritionScore = 60,
                nutriGrade = "A",
                additiveScore = 30,
                organicScore = 0,
                swap = null
            ),
            sampleItem(
                title = "Gatorade Thirst Quencher Fruit Punch Sports Drink, 20 fl oz",
                brand = "Gatorade",
                category = "Waters, Seltzers & Hydration",
                score = 6,
                rating = "Poor",
                color = "red",
                imageUrl = productImageUrl("Gatorade Thirst Quencher Fruit Punch 20 oz"),
                description = "Conventional sports electrolyte drink containing 34g added sugar (dextrose & sucrose) and Red 40 petroleum-based food dye.",
                keywords = "gatorade fruit punch cool blue glacier freeze sports drink electrolytes",
                ingredients = "Water, Sugar, Dextrose, Citric Acid, Salt, Sodium Citrate, Monopotassium Phosphate, Gum Arabic, Natural Flavor, Sucrose Acetate Isobutyrate, Glycerol Ester of Rosin, Red 40.",
                flagged = listOf(
                    FlagInfo("Red 40", 25, "high", "Petroleum-derived synthetic azo dye flagged on our clean-label watchlist.")
                ),
                nutritionScore = 0,
                nutriGrade = "E",
                additiveScore = 6,
                organicScore = 0,
                swap = swapObj(
                        "Harmless Harvest Organic Coconut Water",
                        "Harmless Harvest",
                        88,
                        productImageUrl("Harmless Harvest Organic Coconut Water"),
                        "100% Organic Coconut Water.",
                        isOrganic = true
                    )
            ),
            sampleItem(
                title = "Prime Hydration Drink Ice Pop, 16.9 fl oz",
                brand = "Prime",
                category = "Waters, Seltzers & Hydration",
                score = 42,
                rating = "Poor",
                color = "red",
                imageUrl = productImageUrl("Prime Hydration Drink Ice Pop 16.9 oz"),
                description = "Coconut-water sports hydration beverage with electrolytes and BCAAs, sweetened with sucralose and acesulfame potassium.",
                keywords = "prime hydration drink ice pop blue raspberry tropical punch logan paul",
                ingredients = "Filtered Water, Coconut Water from Concentrate, Citric Acid, Dipotassium Phosphate, Trimagnesium Citrate, Natural Flavor, Sucralose, L-Isoleucine, L-Leucine, L-Valine, D-Alpha Tocopheryl Acetate, Acesulfame Potassium, Beta Carotene for Color, Pyridoxine Hydrochloride, Cyanocobalamin.",
                flagged = listOf(
                    FlagInfo("Sucralose", 15, "moderate", "Synthetic chlorinated sweetener."),
                    FlagInfo("Acesulfame Potassium (Ace-K)", 15, "moderate", "Synthetic high-intensity sweetener.")
                ),
                nutritionScore = 36,
                nutriGrade = "C",
                additiveScore = 6,
                organicScore = 0,
                swap = swapObj(
                        "Harmless Harvest Organic Coconut Water",
                        "Harmless Harvest",
                        88,
                        productImageUrl("Harmless Harvest Organic Coconut Water"),
                        "100% Organic Coconut Water.",
                        isOrganic = true
                    )
            ),
            // ==================== JUICES, SMOOTHIES & TEA ====================
            sampleItem(
                title = "Simply Orange Pulp Free 100% Pure Squeezed Orange Juice, 52 fl oz",
                brand = "Simply",
                category = "Juices, Smoothies & Tea",
                score = 72,
                rating = "Mediocre",
                color = "yellow",
                imageUrl = productImageUrl("Simply Orange Pulp Free 100% Orange Juice"),
                description = "100% pure squeezed non-GMO pasteurized orange juice, never from concentrate, with zero added sugars or preservatives.",
                keywords = "simply orange juice pulp free tropicana 100% orange juice oj",
                ingredients = "100% Pure Squeezed Pasteurized Orange Juice.",
                flagged = emptyList(),
                nutritionScore = 42,
                nutriGrade = "B",
                additiveScore = 30,
                organicScore = 0,
                swap = null
            ),
            sampleItem(
                title = "Harmless Harvest Organic Coconut Water, 16 fl oz",
                brand = "Harmless Harvest",
                category = "Juices, Smoothies & Tea",
                score = 88,
                rating = "Excellent",
                color = "green",
                imageUrl = productImageUrl("Harmless Harvest Organic Coconut Water"),
                description = "Single-ingredient USDA Organic young Nam Hom coconut water from Thailand, micro-filtered rather than thermally pasteurized.",
                keywords = "harmless harvest organic coconut water pink coconut water electrolytes",
                ingredients = "100% Organic Coconut Water.",
                flagged = emptyList(),
                nutritionScore = 48,
                nutriGrade = "B",
                additiveScore = 30,
                organicScore = 10,
                swap = null
            ),
            sampleItem(
                title = "SunnyD Tangy Original Citrus Punch, 64 fl oz",
                brand = "SunnyD",
                category = "Juices, Smoothies & Tea",
                score = 6,
                rating = "Poor",
                color = "red",
                imageUrl = productImageUrl("SunnyD Tangy Original Citrus Punch"),
                description = "Sweetened citrus punch with only 5% juice, high fructose corn syrup, canola oil, sucralose, Ace-K, Yellow 5, and Yellow 6.",
                keywords = "sunnyd sunny delight citrus punch orange drink",
                ingredients = "Water, High Fructose Corn Syrup and 2% or Less of: Concentrated Juices (Orange, Tangerine, Apple, Lime, Grapefruit, Pear), Citric Acid, Ascorbic Acid, Thiamin Hydrochloride, Natural Flavors, Modified Cornstarch, Canola Oil, Sodium Citrate, Cellulose Gum, Sucralose, Acesulfame Potassium, Neotame, Sodium Hexametaphosphate, Potassium Sorbate, Yellow 5, Yellow 6.",
                flagged = listOf(
                    FlagInfo("Yellow 5", 25, "high", "Synthetic azo dye."),
                    FlagInfo("Yellow 6", 25, "high", "Synthetic azo dye."),
                    FlagInfo("Canola Oil", 15, "moderate", "Refined industrial seed oil."),
                    FlagInfo("High-Fructose Corn Syrup", 15, "moderate", "Industrial liquid sweetener."),
                    FlagInfo("Sucralose", 15, "moderate", "Synthetic chlorinated sweetener.")
                ),
                nutritionScore = 0,
                nutriGrade = "E",
                additiveScore = 6,
                organicScore = 0,
                swap = swapObj(
                    "Uncle Matt's Organic 100% Orange Juice",
                    "Uncle Matt's Organic",
                    88,
                    productImageUrl("Uncle Matt's Organic Orange Juice"),
                    "100% Organic Pasteurized Orange Juice."
                )
            ),
            sampleItem(
                title = "Starbucks Frappuccino Mocha Chilled Coffee Drink, 13.7 fl oz Bottle",
                brand = "Starbucks",
                category = "Juices, Smoothies & Tea",
                score = 30,
                rating = "Poor",
                color = "red",
                imageUrl = productImageUrl("Starbucks Frappuccino Mocha Coffee Drink Bottle"),
                description = "Sweetened bottled iced coffee drink made with reduced-fat milk, coffee, 46g total sugars, and pectin.",
                keywords = "starbucks frappuccino mocha vanilla caramel iced coffee drink bottle",
                ingredients = "Brewed Starbucks Coffee (Water, Coffee), Reduced-Fat Milk, Sugar, Cocoa, Natural Flavors, Pectin, Ascorbic Acid.",
                flagged = emptyList(),
                nutritionScore = 0,
                nutriGrade = "E",
                additiveScore = 30,
                organicScore = 0,
                swap = swapObj(
                    "Stok Organic Unsweetened Black Cold Brew Coffee",
                    "Stok",
                    94,
                    productImageUrl("Stok Unsweetened Black Cold Brew Coffee"),
                    "Coffee (Filtered Water, Organic Arabica Coffee)."
                )
            ),
            // ==================== ADDITIONAL MILK & PLANT MILKS ====================
            sampleItem(
                title = "Fairlife Ultra-Filtered Whole Milk, Lactose-Free, 52 fl oz",
                brand = "Fairlife",
                category = "Milk & Dairy",
                score = 90,
                rating = "Excellent",
                color = "green",
                imageUrl = productImageUrl("Fairlife Ultra Filtered Whole Milk 52 oz"),
                description = "Ultra-filtered lactose-free whole milk with 50% more protein (13g) and 50% less sugar (6g) than regular milk.",
                keywords = "fairlife milk whole milk 2% milk ultra filtered lactose free high protein",
                ingredients = "Ultra-Filtered Milk, Lactase Enzyme, Vitamin A Palmitate, Vitamin D3.",
                flagged = emptyList(),
                nutritionScore = 60,
                nutriGrade = "A",
                additiveScore = 30,
                organicScore = 0,
                swap = null
            ),
            sampleItem(
                title = "MALK Organic Unsweetened Almond Milk, 28 fl oz",
                brand = "MALK Organics",
                category = "Milk & Dairy",
                score = 100,
                rating = "Excellent",
                color = "green",
                imageUrl = productImageUrl("MALK Organic Unsweetened Almond Milk"),
                description = "3-ingredient USDA Organic almond milk with zero seed oils, zero gums, zero carrageenan, and zero synthetic fillers.",
                keywords = "malk organic almond milk oat milk clean plant milk",
                ingredients = "Filtered Water, Organic Almonds, Himalayan Pink Salt.",
                flagged = emptyList(),
                nutritionScore = 60,
                nutriGrade = "A",
                additiveScore = 30,
                organicScore = 10,
                swap = null
            ),
            sampleItem(
                title = "Oatly Original Oat Milk, 64 fl oz",
                brand = "Oatly",
                category = "Milk & Dairy",
                score = 63,
                rating = "Mediocre",
                color = "yellow",
                imageUrl = productImageUrl("Oatly Original Oat Milk 64 oz"),
                description = "Creamy Swedish oat milk fortified with vitamins; contains refined rapeseed (canola) oil and dipotassium phosphate.",
                keywords = "oatly oat milk original barista edition plant milk",
                ingredients = "Oat Base (Water, Oats), Low Erucic Acid Rapeseed Oil, Contains 2% or Less of: Dipotassium Phosphate, Calcium Carbonate, Tricalcium Phosphate, Sea Salt, Dicalcium Phosphate, Riboflavin, Vitamin A Acetate, Vitamin D2, Vitamin B12.",
                flagged = listOf(
                    FlagInfo("Canola / Rapeseed Oil", 15, "moderate", "Refined industrial seed oil used for mouthfeel.")
                ),
                nutritionScore = 48,
                nutriGrade = "B",
                additiveScore = 15,
                organicScore = 0,
                swap = swapObj(
                        "Califia Farms Organic Unsweetened Oatmilk",
                        "Califia Farms",
                        90,
                        productImageUrl("Califia Farms Organic Unsweetened Oatmilk"),
                        "Purified Water, Organic Oats, Sea Salt.",
                        isOrganic = true
                    )
            ),
            sampleItem(
                title = "Nesquik Chocolate Lowfat Milk Ready-to-Drink, 14 fl oz",
                brand = "Nesquik",
                category = "Milk & Dairy",
                score = 18,
                rating = "Poor",
                color = "red",
                imageUrl = productImageUrl("Nesquik Chocolate Lowfat Milk 14 oz"),
                description = "Sweetened ready-to-drink chocolate lowfat milk containing 27g sugars and carrageenan thickener.",
                keywords = "nesquik chocolate milk strawberry milk truemoo darigold",
                ingredients = "Lowfat Milk with Vitamin A Palmitate and Vitamin D3 Added, Sugar, Less than 2% of Cocoa Processed with Alkali, Nonfat Milk, Salt, Natural and Artificial Flavor, Carrageenan, Cellulose Gel, Cellulose Gum.",
                flagged = listOf(
                    FlagInfo("Carrageenan", 25, "high", "Seaweed-derived thickener flagged on our clean-label watchlist.")
                ),
                nutritionScore = 12,
                nutriGrade = "D",
                additiveScore = 6,
                organicScore = 0,
                swap = swapObj(
                        "Horizon Organic Lowfat Chocolate Milk",
                        "Horizon Organic",
                        76,
                        productImageUrl("Horizon Organic Lowfat Chocolate Milk"),
                        "Organic Grade A Lowfat Milk, Organic Cane Sugar, Organic Fair Trade Cocoa, Gellan Gum, Vitamin A Palmitate, Vitamin D3.",
                        isOrganic = true
                    )
            ),
            sampleItem(
                title = "Simple Truth Organic Whole Milk Plain Greek Yogurt",
                brand = "Simple Truth Organic",
                category = "Milk & Dairy",
                score = 100,
                rating = "Excellent",
                color = "green",
                imageUrl = productImageUrl("Simple Truth Organic Whole Milk Plain Greek Yogurt"),
                description = "Kroger Simple Truth USDA Organic whole milk plain Greek yogurt with live and active probiotic cultures and zero added sugar.",
                keywords = "simple truth organic greek yogurt kroger plain greek yogurt yogurt",
                ingredients = "Cultured Pasteurized Organic Whole Milk. Live and Active Cultures: S. Thermophilus, L. Bulgaricus, L. Acidophilus, Bifidus, L. Casei.",
                flagged = emptyList(),
                nutritionScore = 60,
                nutriGrade = "A",
                additiveScore = 30,
                organicScore = 10,
                swap = null,
                storeKey = "kroger"
            ),
            sampleItem(
                title = "Good & Gather Organic Creamy Peanut Butter",
                brand = "Good & Gather",
                category = "Peanut Butter",
                score = 85,
                rating = "Excellent",
                color = "green",
                imageUrl = productImageUrl("Good & Gather Organic Creamy Peanut Butter"),
                description = "Target & Shipt Good & Gather USDA Organic 2-ingredient creamy peanut butter made with organic dry-roasted peanuts and sea salt.",
                keywords = "good & gather good and gather organic creamy peanut butter target shipt peanut butter",
                ingredients = "Organic Dry Roasted Peanuts, Sea Salt.",
                flagged = emptyList(),
                nutritionScore = 45,
                nutriGrade = "A",
                additiveScore = 30,
                organicScore = 10,
                swap = null,
                storeKey = "target"
            ),
            sampleItem(
                title = "Big K Cola Soda, 12 fl oz",
                brand = "Big K",
                category = "Sodas & Prebiotic Drinks",
                score = 7,
                rating = "Poor",
                color = "red",
                imageUrl = productImageUrl("Big K Cola Soda 12 fl oz"),
                description = "Kroger store-brand carbonated cola sweetened with high fructose corn syrup and colored with Class IV caramel color.",
                keywords = "big k cola soda kroger cola soda pop",
                ingredients = "Carbonated Water, High Fructose Corn Syrup, Caramel Color, Phosphoric Acid, Natural Flavor, Caffeine.",
                flagged = listOf(
                    FlagInfo("High Fructose Corn Syrup (HFCS)", 18, "high", "Concentrated industrial fructose syrup."),
                    FlagInfo("Caramel Color (Class III/IV)", 18, "high", "Synthetic coloring agent.")
                ),
                nutritionScore = 0,
                nutriGrade = "E",
                additiveScore = 7,
                organicScore = 0,
                swap = swapObj(
                    "OLIPOP Classic Vintage Cola Prebiotic Soda",
                    "OLIPOP",
                    82,
                    productImageUrl("OLIPOP Vintage Cola"),
                    "Carbonated Water, OLISMART (Cassava Root Fiber, Chicory Root Inulin, Jerusalem Artichoke Inulin, Nopal Cactus, Marshmallow Root, Calendula Flower, Kudzu Root), Apple Juice Concentrate, Cassava Root Syrup, Cane Sugar, Caramel, Natural Vanilla Flavor, Cinnamon Extract, Stevia Leaf, Himalayan Pink Salt, Green Tea Caffeine."
                ),
                storeKey = "kroger"
            ),
            sampleItem(
                title = "Private Selection Angus Beef Patties",
                brand = "Private Selection",
                category = "Meat & Poultry",
                score = 90,
                rating = "Excellent",
                color = "green",
                imageUrl = productImageUrl("Private Selection Angus Beef Patties"),
                description = "Kroger Private Selection single-ingredient 100% USDA Choice Angus beef chuck patties with zero fillers or preservatives.",
                keywords = "private selection angus beef patties kroger burger beef chuck",
                ingredients = "100% USDA Choice Angus Beef.",
                flagged = emptyList(),
                nutritionScore = 60,
                nutriGrade = "A",
                additiveScore = 30,
                organicScore = 0,
                swap = null,
                storeKey = "kroger"
            ),
            sampleItem(
                title = "Favorite Day Classic Vanilla Ice Cream",
                brand = "Favorite Day",
                category = "Milk & Dairy",
                score = 33,
                rating = "Poor",
                color = "red",
                imageUrl = productImageUrl("Favorite Day Classic Vanilla Ice Cream"),
                description = "Target Favorite Day vanilla ice cream containing corn syrup, mono and diglycerides, and carrageenan.",
                keywords = "favorite day classic vanilla ice cream target vanilla bean ice cream",
                ingredients = "Milk, Cream, Skim Milk, Sugar, Corn Syrup, Egg Yolks, Natural Flavor, Mono and Diglycerides, Guar Gum, Locust Bean Gum, Carrageenan, Annatto Extract (Color).",
                flagged = listOf(
                    FlagInfo("Carrageenan", 25, "high", "Seaweed-derived thickener flagged on our clean-label watchlist."),
                    FlagInfo("Mono- and Diglycerides", 15, "moderate", "Synthetic lipid emulsifier.")
                ),
                nutritionScore = 27,
                nutriGrade = "D",
                additiveScore = 6,
                organicScore = 0,
                swap = swapObj(
                        "Alden's Organic Old Fashioned Vanilla Ice Cream",
                        "Alden's Organic",
                        84,
                        productImageUrl("Alden's Organic Old Fashioned Vanilla Ice Cream"),
                        "Organic Milk, Organic Cream, Organic Cane Sugar, Organic Egg Yolks, Organic Vanilla Extract, Organic Tapioca Starch.",
                        isOrganic = true
                    ),
                storeKey = "target"
            ),
            sampleItem(
                title = "Favorite Day Cookies & Cream Ice Cream",
                brand = "Favorite Day",
                category = "Milk & Dairy",
                score = 21,
                rating = "Poor",
                color = "red",
                imageUrl = productImageUrl("Favorite Day Cookies & Cream Ice Cream"),
                description = "Target Favorite Day cookies & cream ice cream containing wheat flour, soybean/palm oil, soy lecithin, corn syrup, and carrageenan.",
                keywords = "favorite day cookies & cream cookies and cream ice cream target",
                ingredients = "Milk, Cream, Sugar, Corn Syrup, Skim Milk, Chocolate Sandwich Cookies (Unbleached Enriched Flour [Wheat Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid], Sugar, Soybean and/or Palm Oil, Cocoa Processed with Alkali, Invert Sugar, Corn Flour, Chocolate, Salt, Baking Soda, Soy Lecithin, Natural Flavor), Whey, Mono and Diglycerides, Guar Gum, Cellulose Gum, Carrageenan, Natural Flavor, Vitamin A Palmitate.",
                flagged = listOf(
                    FlagInfo("Carrageenan", 25, "high", "Seaweed-derived thickener flagged on our clean-label watchlist."),
                    FlagInfo("Soybean Oil", 15, "moderate", "Refined industrial seed oil."),
                    FlagInfo("Palm Oil", 15, "moderate", "Refined tropical oil."),
                    FlagInfo("Mono- and Diglycerides", 15, "moderate", "Synthetic lipid emulsifier.")
                ),
                nutritionScore = 15,
                nutriGrade = "D",
                additiveScore = 6,
                organicScore = 0,
                swap = swapObj(
                        "Alden's Organic Cookies & Cream Ice Cream",
                        "Alden's Organic",
                        82,
                        productImageUrl("Alden's Organic Cookies & Cream Ice Cream"),
                        "Organic Milk, Organic Cream, Organic Cane Sugar, Organic Cookies (Organic Wheat Flour, Organic Cane Sugar, Organic Coconut Oil, Organic Cocoa, Baking Soda, Salt), Organic Vanilla Extract.",
                        isOrganic = true
                    ),
                storeKey = "target"
            ),
            sampleItem(
                title = "Fresh Whole Sweet Potato",
                brand = "Fresh Produce",
                category = "Produce & Whole Foods",
                score = 90,
                rating = "Excellent",
                color = "green",
                imageUrl = productImageUrl("Fresh Whole Sweet Potato"),
                description = "Single-ingredient whole fresh sweet potato. Naturally rich in beta-carotene (vitamin A), dietary fiber, and potassium with 0g fat and zero seed oils or additives.",
                keywords = "fresh whole sweet potato sweet potatoes yam yams produce",
                ingredients = "100% Fresh Whole Sweet Potato (Single-Ingredient Whole Produce).",
                flagged = emptyList(),
                nutritionScore = 60,
                nutriGrade = "A",
                additiveScore = 30,
                organicScore = 0,
                swap = null
            ),
            sampleItem(
                title = "Fresh Whole Russet Potatoes, 5 lb Bag",
                brand = "Fresh Produce",
                category = "Produce & Whole Foods",
                score = 90,
                rating = "Excellent",
                color = "green",
                imageUrl = productImageUrl("Fresh Whole Russet Potatoes"),
                description = "Single-ingredient whole fresh russet potatoes with 0g fat and zero seed oils or additives.",
                keywords = "fresh whole russet potatoes idaho potatoes baking potatoes 5 lb bag produce",
                ingredients = "100% Fresh Whole Russet Potatoes (Single-Ingredient Whole Produce).",
                flagged = emptyList(),
                nutritionScore = 60,
                nutriGrade = "A",
                additiveScore = 30,
                organicScore = 0,
                swap = null
            ),
            sampleItem(
                title = "Butterball Frozen Whole Turkey, All Natural, 10-16 lbs.",
                brand = "Butterball",
                category = "Meat, Poultry & Deli",
                score = 70,
                rating = "Mediocre",
                color = "yellow",
                imageUrl = productImageUrl("Butterball Frozen Whole Turkey"),
                description = "All-natural whole young turkey basted with water, salt, spices, and natural flavoring (no MSG, no artificial preservatives, no gluten).",
                keywords = "butterball frozen whole turkey all natural 10-16 lbs thanksgiving turkey",
                ingredients = "Young Turkey, Contains up to 8% of a Solution of Water, Salt, Spices, and Natural Flavoring to Deeply Baste the Turkey.",
                flagged = listOf(
                    FlagInfo("Natural Flavors", 5, "low", "Proprietary flavor blend that can include solvents and carriers.")
                ),
                nutritionScore = 45,
                nutriGrade = "B",
                additiveScore = 25,
                organicScore = 0,
                swap = null
            )
        )
    }

    private data class FlagInfo(val name: String, val penalty: Int, val risk: String, val explanation: String)

    fun storePackagesForKey(storeKey: String): List<String> = when (storeKey.lowercase()) {
        "walmart" -> listOf("com.walmart.android")
        "target" -> listOf("com.target.ui")
        "instacart" -> listOf("com.instacart.client")
        "aldi" -> listOf("de.apptiv.business.android.aldi_us")
        "bjs" -> listOf("com.bjs.mobile", "com.brandingbrand.reactnative.and.bjs")
        "costco" -> listOf("com.costco.app.android")
        "kroger" -> listOf("com.kroger.mobile")
        "sams" -> listOf("com.rfi.sams.android", "com.samsclub.app")
        "wholefoods" -> listOf("com.wholefoods.wholefoodsmarket", "com.amazon.mShop.android.shopping")
        "amazon" -> listOf("com.amazon.mShop.android.shopping")
        "doordash" -> listOf("com.dd.doordash")
        "ubereats" -> listOf("com.ubercab.eats")
        "shipt" -> listOf("com.shipt.groceries")
        else -> emptyList()
    }

    fun resolveInstalledStorePackage(context: Context, storeKey: String): String? {
        val pm = context.packageManager
        return storePackagesForKey(storeKey).firstOrNull { pkg ->
            runCatching { pm.getLaunchIntentForPackage(pkg) }.getOrNull() != null
        }
    }

    fun storePackageForKey(storeKey: String): String =
        storePackagesForKey(storeKey).firstOrNull().orEmpty()

    fun storeSearchUrl(storeKey: String, query: String): String {
        val encoded = java.net.URLEncoder.encode(query.trim(), "UTF-8")
        return when (storeKey.lowercase()) {
            "target" -> "https://www.target.com/s?searchTerm=$encoded"
            "instacart" -> "https://www.instacart.com/store/s?k=$encoded"
            "aldi" -> "https://shop.aldi.us/store/aldi/s?k=$encoded"
            "bjs" -> "https://www.bjs.com/search/$encoded"
            "costco" -> "https://www.costco.com/CatalogSearch?keyword=$encoded"
            "kroger" -> "https://www.kroger.com/search?query=$encoded"
            "sams" -> "https://www.samsclub.com/s/$encoded"
            "amazon", "wholefoods" -> "https://www.amazon.com/s?k=$encoded&i=amazonfresh"
            "doordash" -> "https://www.doordash.com/search/store/$encoded/"
            "ubereats" -> "https://www.ubereats.com/search?q=$encoded"
            "shipt" -> "https://www.shipt.com/shop/search?query=$encoded"
            else -> "https://www.walmart.com/search?q=$encoded"
        }
    }

    private val KROGER_BANNER_DOMAINS = listOf(
        "kroger.com", "ralphs.com", "fredmeyer.com", "frysfood.com", "kingsoopers.com",
        "smithsfoodanddrug.com", "qfc.com", "harristeeter.com", "marianos.com", "picknsave.com",
        "metromarket.net", "metro-market.net", "dillons.com", "bakersplus.com", "citymarket.com",
        "gerbes.com", "jaycfoods.com", "pay-less.com", "food4less.com", "foodsco.net",
        "foodscomarket.com", "owensmarket.com", "rulerfoods.com"
    )

    private fun singleUrlMatchesStore(rawUrl: String, storeKey: String): Boolean {
        val u = rawUrl.lowercase()
        return when (storeKey.lowercase()) {
            "walmart" -> u.contains("walmart.com")
            "target" -> u.contains("target.com")
            "instacart" -> u.contains("instacart.com")
            "aldi" -> u.contains("aldi.us")
            "bjs" -> u.contains("bjs.com")
            "costco" -> u.contains("costco.com")
            "kroger" -> KROGER_BANNER_DOMAINS.any { u.contains(it) }
            "sams" -> u.contains("samsclub.com")
            "wholefoods" -> u.contains("amazon.com") || u.contains("wholefoodsmarket.com")
            "amazon" -> u.contains("amazon.com")
            "doordash" -> u.contains("doordash.com")
            "ubereats" -> u.contains("ubereats.com")
            "shipt" -> u.contains("shipt.com")
            else -> false
        }
    }

    fun urlMatchesStore(url: String, storeKey: String): Boolean {
        val trimmed = url.trim()
        if (trimmed.isEmpty()) return false
        if (singleUrlMatchesStore(trimmed, storeKey)) return true
        val paramMatch = Regex("[?&](?:u|url)=([^&#]+)", RegexOption.IGNORE_CASE).find(trimmed)
        if (paramMatch != null) {
            val rawParam = paramMatch.groupValues[1]
            val decodedOnce = runCatching { java.net.URLDecoder.decode(rawParam, "UTF-8") }.getOrDefault(rawParam)
            if (singleUrlMatchesStore(decodedOnce, storeKey)) return true
            val decodedTwice = runCatching { java.net.URLDecoder.decode(decodedOnce, "UTF-8") }.getOrDefault(decodedOnce)
            if (singleUrlMatchesStore(decodedTwice, storeKey)) return true
        }
        return false
    }

    fun isTrackedAffiliateUrl(url: String): Boolean {
        val low = url.lowercase()
        val host = runCatching { android.net.Uri.parse(url).host?.lowercase().orEmpty() }.getOrDefault("")
        return LiveStoreBrowserActivity.isAllowedAffiliateRedirectHost(host) ||
            low.contains("subid1=") ||
            low.contains("tag=") ||
            low.contains("irclickid=") ||
            low.contains("ojrq.net") ||
            low.contains("pntra.com") ||
            low.contains("oloiyb.net")
    }

    fun isStoreBrandForStore(text: String, storeKey: String): Boolean {
        val t = text.trim()
        if (t.isEmpty()) return false
        return when (storeKey.lowercase().trim()) {
            "walmart" -> Regex("\\b(great\\s+value|bettergoods|marketside|sam'?s\\s+choice)\\b", RegexOption.IGNORE_CASE).containsMatchIn(t)
            "target" -> Regex("\\b(good\\s*&\\s*gather|favorite\\s+day|market\\s+pantry|simply\\s+balanced)\\b", RegexOption.IGNORE_CASE).containsMatchIn(t)
            "aldi" -> Regex("\\b(simply\\s+nature|millville|clancy'?s|specially\\s+selected|park\\s+street\\s+deli)\\b", RegexOption.IGNORE_CASE).containsMatchIn(t)
            "costco" -> Regex("\\bkirkland\\b", RegexOption.IGNORE_CASE).containsMatchIn(t)
            "sams" -> Regex("\\bmember'?s\\s+mark\\b", RegexOption.IGNORE_CASE).containsMatchIn(t)
            "kroger" -> Regex("\\b(simple\\s+truth|private\\s+selection)\\b", RegexOption.IGNORE_CASE).containsMatchIn(t)
            "amazon", "wholefoods" -> Regex("\\b(365\\b|whole\\s+foods|amazon\\s+fresh|happy\\s+belly|wickedly\\s+prime)\\b", RegexOption.IGNORE_CASE).containsMatchIn(t)
            "bjs" -> Regex("\\b(wellsley\\s+farms|berkley\\s+jensen)\\b", RegexOption.IGNORE_CASE).containsMatchIn(t)
            "instacart", "shipt", "doordash", "ubereats" -> Regex(
                "\\b(great\\s+value|bettergoods|marketside|good\\s*&\\s*gather|simply\\s+nature|kirkland|member'?s\\s+mark|simple\\s+truth|private\\s+selection|365\\s+by\\s+whole\\s+foods|wellsley\\s+farms)\\b",
                RegexOption.IGNORE_CASE
            ).containsMatchIn(t)
            else -> false
        }
    }

    fun upgradeSwapForStore(swap: JSONObject, @Suppress("UNUSED_PARAMETER") prodTitle: String = "", storeKey: String = "walmart") {
        val normStore = storeKey.lowercase().ifBlank { "walmart" }
        val isWalmart = normStore == "walmart"
        val latestTitle = swap.optString("title")
        val latestBrand = swap.optString("brand")
        swap.put("isStoreBrand", isStoreBrandForStore("$latestBrand $latestTitle", normStore))

        val curLink = swap.optString("deepLink").ifBlank { swap.optString("webUrl") }
        val isLocked = swap.optBoolean("locked", false) || curLink.isBlank()
        if (isLocked) {
            swap.put("locked", true)
            swap.remove("webUrl")
            swap.remove("deepLink")
            swap.remove("androidIntentUrl")
            return
        }

        val targetPkg = storePackageForKey(normStore)
        if (targetPkg.isNotBlank()) {
            swap.put("androidPackage", targetPkg)
        }

        if (
            (swap.optBoolean("isPaidLink", false) || isTrackedAffiliateUrl(curLink)) &&
            urlMatchesStore(curLink, normStore)
        ) {
            return
        }

        val latestQuery = swap.optString("searchQuery").ifBlank { latestTitle }
        if (curLink.contains("/ip/10898744") && latestQuery.isNotBlank()) {
            val fixedSearchUrl = storeSearchUrl(normStore, latestQuery)
            swap.put("webUrl", fixedSearchUrl)
            swap.put("deepLink", fixedSearchUrl)
            swap.put("isPaidLink", false)
        } else if (isWalmart) {
            val latestSwapLow = latestTitle.lowercase()
            if (!urlMatchesStore(curLink, "walmart") || !curLink.contains("/ip/")) {
                val walmartItemId = when {
                    latestSwapLow.contains("american cheese slices") -> "1814292019"
                    latestSwapLow.contains("sharp cheddar") && latestSwapLow.contains("organic valley") -> "19757363"
                    latestSwapLow.contains("millet") && latestSwapLow.contains("ramen") -> "42708184"
                    latestSwapLow.contains("grass-fed") && latestSwapLow.contains("ground beef") -> "51259058"
                    latestSwapLow.contains("cream of chicken") && latestSwapLow.contains("pacific") -> "541659748"
                    latestSwapLow.contains("lentil vegetable soup") -> "29873666"
                    latestSwapLow.contains("chicken & maple breakfast sausage") -> "967953484"
                    latestSwapLow.contains("21 whole grains") && latestSwapLow.contains("buns") -> "975361545"
                    latestSwapLow.contains("21 whole grains") && latestSwapLow.contains("bread") -> "45804393"
                    latestSwapLow.contains("plain awesome bagels") -> "109128726"
                    latestSwapLow.contains("stonyfield") && latestSwapLow.contains("yogurt") -> "10535275"
                    latestSwapLow.contains("oven roasted turkey breast") && latestSwapLow.contains("applegate") -> "15610519"
                    latestSwapLow.contains("boulder canyon") && latestSwapLow.contains("kettle chips") -> "44391408"
                    latestSwapLow.contains("unsalted butter") && latestSwapLow.contains("organic valley") -> "10804557"
                    latestSwapLow.contains("salted butter") && latestSwapLow.contains("organic valley") -> "10804556"
                    latestSwapLow.contains("primal kitchen") && latestSwapLow.contains("ranch") -> "262135036"
                    latestSwapLow.contains("larabar") && latestSwapLow.contains("cashew cookie") -> "10311442"
                    latestSwapLow.contains("simple mills") && latestSwapLow.contains("chocolate chip cookies") -> "189635069"
                    latestSwapLow.contains("2% reduced fat milk") && latestSwapLow.contains("organic valley") -> "142608569"
                    latestSwapLow.contains("whole milk") && latestSwapLow.contains("organic valley") -> "142608568"
                    latestSwapLow.contains("sweet cream coffee creamer") && latestSwapLow.contains("organic valley") -> "46330062"
                    latestSwapLow.contains("califia") && latestSwapLow.contains("oatmilk") -> "269553533"
                    latestSwapLow.contains("califia") && latestSwapLow.contains("almondmilk") -> "520102935"
                    latestSwapLow.contains("sour cream") && latestSwapLow.contains("organic valley") -> "24524912"
                    latestSwapLow.contains("cream cheese") && latestSwapLow.contains("organic valley") -> "24524911"
                    latestSwapLow.contains("vital farms") && latestSwapLow.contains("eggs") -> "47908222"
                    latestSwapLow.contains("santa cruz") && latestSwapLow.contains("peanut butter") -> "10308907"
                    latestSwapLow.contains("siete") && latestSwapLow.contains("tortilla chips") -> "526863587"
                    latestSwapLow.contains("siete") && latestSwapLow.contains("tortillas") -> "506938184"
                    latestSwapLow.contains("bob's red mill") && latestSwapLow.contains("rolled oats") -> "10449439"
                    latestSwapLow.contains("coombs family farms") && latestSwapLow.contains("maple syrup") -> "10315075"
                    latestSwapLow.contains("primal kitchen") && latestSwapLow.contains("mayonnaise") -> "673755804"
                    latestSwapLow.contains("primal kitchen") && latestSwapLow.contains("ketchup") -> "904602875"
                    latestSwapLow.contains("annie's") && latestSwapLow.contains("yellow mustard") -> "15556013"
                    latestSwapLow.contains("primal kitchen") && latestSwapLow.contains("bbq sauce") -> "478556215"
                    latestSwapLow.contains("rao's") && latestSwapLow.contains("marinara") -> "47228945"
                    latestSwapLow.contains("mateo's") && latestSwapLow.contains("salsa") -> "37552509"
                    latestSwapLow.contains("sunday bacon") && latestSwapLow.contains("applegate") -> "22210691"
                    latestSwapLow.contains("beef hot dog") && latestSwapLow.contains("applegate") -> "15610515"
                    latestSwapLow.contains("chicken nuggets") && latestSwapLow.contains("applegate") -> "21296165"
                    latestSwapLow.contains("barilla") && latestSwapLow.contains("spaghetti") -> "51259268"
                    latestSwapLow.contains("spindrift") && latestSwapLow.contains("raspberry lime") -> "895065260"
                    latestSwapLow.contains("olipop") && latestSwapLow.contains("vintage cola") -> "848292458"
                    latestSwapLow.contains("harmless harvest") && latestSwapLow.contains("coconut water") -> "46330157"
                    latestSwapLow.contains("stok") && latestSwapLow.contains("cold brew") -> "172959656"
                    else -> null
                }
                if (walmartItemId != null) {
                    swap.put("webUrl", "https://www.walmart.com/ip/$walmartItemId")
                    swap.put("deepLink", "https://www.walmart.com/ip/$walmartItemId")
                    swap.put("isPaidLink", false)
                } else if (!urlMatchesStore(curLink, "walmart") && latestQuery.isNotBlank()) {
                    val searchUrl = storeSearchUrl("walmart", latestQuery)
                    swap.put("webUrl", searchUrl)
                    swap.put("deepLink", searchUrl)
                    swap.put("isPaidLink", false)
                }
            }
        } else if (!urlMatchesStore(curLink, normStore) && latestQuery.isNotBlank()) {
            val searchUrl = storeSearchUrl(normStore, latestQuery)
            swap.put("webUrl", searchUrl)
            swap.put("deepLink", searchUrl)
            swap.put("isPaidLink", false)
        }
    }

    private fun swapObj(
        title: String,
        brand: String,
        score: Int,
        imageUrl: String,
        ingredients: String,
        isOrganic: Boolean = false
    ): JSONObject = JSONObject().apply {
        put("title", title)
        put("brand", brand)
        put("score", score)
        put("imageUrl", imageUrl)
        val catArt = resolveCategoryStudioArt(title, "", ingredients)
        if (catArt.isNotEmpty()) put("categoryArtUrl", catArt)
        put("ingredients", ingredients)
        put("isOrganic", isOrganic)
        put("why", "No seed oils, synthetic dyes, or high-risk preservatives.")
        put("searchQuery", title)
        val initialUrl = storeSearchUrl("walmart", title)
        put("webUrl", initialUrl)
        put("deepLink", initialUrl)
    }

    private fun sampleItem(
        title: String,
        brand: String,
        category: String,
        score: Int,
        rating: String,
        color: String,
        imageUrl: String,
        ingredients: String,
        flagged: List<FlagInfo>,
        nutritionScore: Int,
        nutriGrade: String,
        additiveScore: Int,
        organicScore: Int,
        swap: JSONObject?,
        description: String = "",
        keywords: String = "",
        storeKey: String = "walmart"
    ): JSONObject = JSONObject().apply {
        put("ok", true)
        put("storeKey", storeKey)
        put("category", category)
        put("lookup", JSONObject().apply {
            put("source", "catalog")
            put("origin", "catalog")
            put("verifiedAt", "2026-11-10")
            put("sourceUpdatedAt", "2026-11-10")
        })
        val isOrg = organicScore > 0
        val catArt = resolveCategoryStudioArt(title, category, ingredients)
        put("product", JSONObject().apply {
            put("title", title)
            put("brand", brand)
            put("category", category)
            put("imageUrl", imageUrl)
            if (catArt.isNotEmpty()) put("categoryArtUrl", catArt)
            put("ingredients", ingredients)
            put("isOrganic", isOrg)
            put("nutrition", JSONObject().apply {
                put("isOrganic", isOrg)
            })
            if (description.isNotBlank()) put("description", description)
            if (keywords.isNotBlank()) put("keywords", keywords)
        })
        val canonicalRating = when {
            score >= 75 -> "Excellent"
            score >= 50 -> "Mediocre"
            else -> "Poor"
        }
        val canonicalColor = when {
            score >= 75 -> "green"
            score >= 50 -> "yellow"
            else -> "red"
        }
        put("result", JSONObject().apply {
            put("score", score)
            put("rating", canonicalRating)
            put("color", canonicalColor)
            put("flagged", JSONArray().apply {
                flagged.forEach { f ->
                    put(JSONObject().apply {
                        put("name", f.name)
                        put("penalty", f.penalty)
                        put("risk", f.risk)
                        put("explanation", f.explanation)
                    })
                }
            })
            put("yukaBreakdown", JSONObject().apply {
                put("nutritionScore", nutritionScore)
                put("nutriScoreGrade", nutriGrade)
                put("additiveScore", additiveScore)
                put("organicScore", organicScore)
                put("highRiskCapped", flagged.any { it.risk == "high" })
            })
        })
        if (swap != null) {
            upgradeSwapForStore(swap, title, storeKey)
            put("swap", swap)
        }
    }
}
