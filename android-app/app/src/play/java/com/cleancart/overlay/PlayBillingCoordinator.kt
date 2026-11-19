package com.cleancart.overlay

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import com.android.billingclient.api.AcknowledgePurchaseParams
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.PendingPurchasesParams
import com.android.billingclient.api.ProductDetails
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.PurchasesUpdatedListener
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.QueryPurchasesParams
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * Google Play Store distribution billing coordinator (`play` product flavor).
 * Uses Google Play Billing Library exclusively for all subscription purchases and management.
 */
object PlayBillingCoordinator {
    const val EXTRA_OPEN_PLAY_PAYWALL = "com.cleancart.overlay.OPEN_PLAY_PAYWALL"
    private const val ANNUAL_PRODUCT_ID = "heybroc_pro_annual"
    private const val MONTHLY_PRODUCT_ID = "heybroc_pro_monthly"
    private const val PLAY_SUBSCRIPTIONS_URL = "https://play.google.com/store/account/subscriptions"
    private const val TERMS_URL = "https://www.heybroc.com/terms"
    private const val PRIVACY_URL = "https://www.heybroc.com/privacy"

    private val mainHandler = Handler(Looper.getMainLooper())
    private val syncInProgress = AtomicBoolean(false)

    @Volatile
    private var cachedPricingSummary: String? = null

    fun cachedLocalizedPricingSummary(): String? = cachedPricingSummary

    fun openUpgradeFromContext(context: Context) {
        val intent = Intent(context, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            putExtra(EXTRA_OPEN_PLAY_PAYWALL, true)
        }
        runCatching { context.startActivity(intent) }
    }

    fun openManageSubscription(activity: Activity) {
        val pkg = Uri.encode(activity.packageName)
        val url = "$PLAY_SUBSCRIPTIONS_URL?package=$pkg"
        runCatching {
            activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        }.onFailure {
            Toast.makeText(activity, "Open Google Play → Payments & subscriptions to manage your plan.", Toast.LENGTH_LONG).show()
        }
    }

    /**
     * Queries active Google Play subscriptions on startup/resume so any pending-to-completed
     * or previously unacknowledged `PURCHASED` subscription is verified against `/api/google/verify`
     * and acknowledged cleanly without losing user entitlement.
     */
    fun syncExistingPurchases(ctx: Context, onProActivated: (() -> Unit)? = null) {
        if (!syncInProgress.compareAndSet(false, true)) return
        val appCtx = ctx.applicationContext
        val queryDispatched = AtomicBoolean(false)
        val client = BillingClient.newBuilder(appCtx)
            .setListener { _, _ -> /* handled when active flow is open */ }
            .enablePendingPurchases(
                PendingPurchasesParams.newBuilder()
                    .enableOneTimeProducts()
                    .build()
            )
            .build()

        fun finishSync(activated: Boolean) {
            mainHandler.post {
                runCatching { client.endConnection() }
                syncInProgress.set(false)
                if (activated) {
                    onProActivated?.invoke()
                }
            }
        }

        client.startConnection(object : BillingClientStateListener {
            override fun onBillingSetupFinished(billingResult: BillingResult) {
                if (billingResult.responseCode != BillingClient.BillingResponseCode.OK) {
                    finishSync(activated = false)
                    return
                }
                if (!queryDispatched.compareAndSet(false, true)) return
                val qParams = QueryPurchasesParams.newBuilder()
                    .setProductType(BillingClient.ProductType.SUBS)
                    .build()
                client.queryPurchasesAsync(qParams) { res, purchases ->
                    if (res.responseCode != BillingClient.BillingResponseCode.OK) {
                        finishSync(activated = false)
                        return@queryPurchasesAsync
                    }
                    val purchased = purchases.filter { it.purchaseState == Purchase.PurchaseState.PURCHASED }
                    if (purchased.isEmpty()) {
                        finishSync(activated = false)
                        return@queryPurchasesAsync
                    }
                    val remaining = AtomicInteger(purchased.size)
                    val anyActivated = AtomicBoolean(false)

                    fun completeOne() {
                        if (remaining.decrementAndGet() == 0) {
                            finishSync(activated = anyActivated.get())
                        }
                    }

                    for (purchase in purchased) {
                        val productId = purchase.products.firstOrNull().orEmpty()
                        val orderId = purchase.orderId.orEmpty()
                        val token = purchase.purchaseToken
                        Thread {
                            val verified = ScanApi.verifyGooglePlayPurchase(
                                ctx = appCtx,
                                purchaseToken = token,
                                productId = productId,
                                orderId = orderId
                            )
                            val serverOk = verified?.optBoolean("ok", false) == true &&
                                verified.optBoolean("active", false)
                            if (!serverOk) {
                                completeOne()
                                return@Thread
                            }
                            if (!purchase.isAcknowledged) {
                                mainHandler.post {
                                    if (!client.isReady) {
                                        completeOne()
                                        return@post
                                    }
                                    val ackParams = AcknowledgePurchaseParams.newBuilder()
                                        .setPurchaseToken(token)
                                        .build()
                                    client.acknowledgePurchase(ackParams) { ackResult ->
                                        if (ackResult.responseCode == BillingClient.BillingResponseCode.OK) {
                                            anyActivated.set(true)
                                        }
                                        completeOne()
                                    }
                                }
                            } else {
                                anyActivated.set(true)
                                completeOne()
                            }
                        }.start()
                    }
                }
            }

            override fun onBillingServiceDisconnected() {
                if (!queryDispatched.get()) {
                    syncInProgress.set(false)
                }
            }
        })
    }

    private data class PlayOfferDisplay(
        val recurringPrice: String,
        val freeTrialLabel: String?,
    )

    private fun formatTrialPeriodLabel(isoPeriod: String?): String {
        return when (isoPeriod?.trim()?.uppercase()) {
            "P3D" -> "3-day free trial"
            "P7D", "P1W" -> "7-day free trial"
            "P14D", "P2W" -> "14-day free trial"
            "P1M" -> "1-month free trial"
            else -> "free trial"
        }
    }

    private fun extractOfferDisplay(details: ProductDetails?): PlayOfferDisplay? {
        val phases = details?.subscriptionOfferDetails
            ?.firstOrNull()
            ?.pricingPhases
            ?.pricingPhaseList
            .orEmpty()
        if (phases.isEmpty()) return null
        val paidPhase = phases.lastOrNull { it.priceAmountMicros > 0L } ?: return null
        val recurringPrice = paidPhase.formattedPrice.takeIf { it.isNotBlank() } ?: return null
        val freeTrialPhase = phases.firstOrNull { it.priceAmountMicros == 0L }
        val trialLabel = freeTrialPhase?.let { formatTrialPeriodLabel(it.billingPeriod) }
        return PlayOfferDisplay(recurringPrice = recurringPrice, freeTrialLabel = trialLabel)
    }

    fun openUpgradeFlow(activity: Activity, onProActivated: (() -> Unit)? = null) {
        if (activity.isFinishing || activity.isDestroyed) return
        val appCtx = activity.applicationContext
        val density = activity.resources.displayMetrics.density
        fun dp(v: Int): Int = (v * density + 0.5f).toInt()

        var dialogRef: AlertDialog? = null
        var billingClient: BillingClient? = null
        var annualDetails: ProductDetails? = null
        var monthlyDetails: ProductDetails? = null
        val inFlightOps = AtomicInteger(0)
        val pendingDisconnect = AtomicBoolean(false)
        val dialogDismissed = AtomicBoolean(false)

        fun safeEndConnectionIfIdle(client: BillingClient?) {
            if (client == null) return
            if (inFlightOps.get() == 0 && pendingDisconnect.get()) {
                runCatching { client.endConnection() }
            }
        }

        val statusView = TextView(activity).apply {
            text = "Loading Google Play plans…"
            textSize = 12.5f
            setTextColor(0xFF475569.toInt())
            setPadding(0, dp(4), 0, dp(8))
        }
        val priceHeadlineView = TextView(activity).apply {
            text = "Loading Google Play plans…"
            textSize = 22f
            setTypeface(null, Typeface.BOLD)
            setTextColor(0xFF0F172A.toInt())
        }
        val priceSubView = TextView(activity).apply {
            text = "Fetching localized subscription pricing & trial availability from Google Play…"
            textSize = 12.5f
            setTextColor(0xFF475569.toInt())
            setPadding(0, dp(2), 0, 0)
        }
        val annualBtn = TextView(activity).apply {
            text = "Loading Annual Plan…"
            textSize = 14.5f
            setTypeface(null, Typeface.BOLD)
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
            isEnabled = false
            alpha = 0.6f
            setPadding(dp(16), dp(14), dp(16), dp(14))
            background = GradientDrawable().apply {
                setColor(0xFF16A34A.toInt())
                cornerRadius = dp(14).toFloat()
            }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { bottomMargin = dp(8) }
        }
        val monthlyBtn = TextView(activity).apply {
            text = "Loading Monthly Plan…"
            textSize = 14f
            setTypeface(null, Typeface.BOLD)
            setTextColor(0xFF0F172A.toInt())
            gravity = Gravity.CENTER
            isEnabled = false
            alpha = 0.6f
            setPadding(dp(16), dp(12), dp(16), dp(12))
            background = GradientDrawable().apply {
                setColor(Color.WHITE)
                setStroke(dp(1), 0xFFCBD5E1.toInt())
                cornerRadius = dp(14).toFloat()
            }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { bottomMargin = dp(10) }
        }
        val retryBtn = TextView(activity).apply {
            text = "Retry Loading Google Play Plans"
            textSize = 13f
            setTypeface(null, Typeface.BOLD)
            setTextColor(0xFF0F7A4A.toInt())
            gravity = Gravity.CENTER
            visibility = View.GONE
            setPadding(dp(14), dp(10), dp(14), dp(10))
            background = GradientDrawable().apply {
                setColor(0xFFECFDF5.toInt())
                setStroke(dp(1), 0xFF86EFAC.toInt())
                cornerRadius = dp(12).toFloat()
            }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { bottomMargin = dp(10) }
        }
        val disclosureView = TextView(activity).apply {
            text = "Auto-renewable subscription billed through Google Play. Localized pricing, billing period, and any introductory trial eligibility are loaded directly from Google Play. Subscription renews automatically unless canceled in Google Play → Payments & subscriptions before renewal."
            textSize = 11f
            setTextColor(0xFF64748B.toInt())
            setPadding(0, dp(8), 0, dp(4))
        }

        fun setPlanButtonsEnabled(enabled: Boolean) {
            val canAnnual = enabled && annualDetails != null
            val canMonthly = enabled && monthlyDetails != null
            annualBtn.isEnabled = canAnnual
            annualBtn.alpha = if (canAnnual) 1f else 0.6f
            monthlyBtn.isEnabled = canMonthly
            monthlyBtn.alpha = if (canMonthly) 1f else 0.6f
        }

        fun handlePurchases(client: BillingClient, purchases: List<Purchase>, isRestore: Boolean) {
            val activePurchases = purchases.filter { it.purchaseState == Purchase.PurchaseState.PURCHASED }
            val pendingPurchases = purchases.filter { it.purchaseState == Purchase.PurchaseState.PENDING }

            if (activePurchases.isEmpty()) {
                mainHandler.post {
                    setPlanButtonsEnabled(true)
                    if (pendingPurchases.isNotEmpty()) {
                        statusView.text = "Payment pending in Google Play — Family Pro will unlock automatically once Google Play completes the charge."
                    } else if (isRestore) {
                        statusView.text = "No active Google Play subscription found on this Google account."
                    }
                }
                return
            }

            mainHandler.post {
                setPlanButtonsEnabled(false)
                statusView.text = "Verifying your Google Play subscription…"
            }

            for (purchase in activePurchases) {
                val productId = purchase.products.firstOrNull().orEmpty()
                val orderId = purchase.orderId.orEmpty()
                val token = purchase.purchaseToken
                inFlightOps.incrementAndGet()

                fun finishOp() {
                    mainHandler.post {
                        if (inFlightOps.decrementAndGet() <= 0) {
                            safeEndConnectionIfIdle(client)
                        }
                    }
                }

                fun completeProUnlock() {
                    mainHandler.post {
                        Toast.makeText(appCtx, "HeyBroc Family Pro activated!", Toast.LENGTH_LONG).show()
                        if (!dialogDismissed.get()) {
                            runCatching { dialogRef?.dismiss() }
                        }
                        onProActivated?.invoke()
                        if (inFlightOps.decrementAndGet() <= 0) {
                            safeEndConnectionIfIdle(client)
                        }
                    }
                }

                Thread {
                    val verified = ScanApi.verifyGooglePlayPurchase(
                        ctx = appCtx,
                        purchaseToken = token,
                        productId = productId,
                        orderId = orderId
                    )
                    val serverOk = verified?.optBoolean("ok", false) == true &&
                        verified.optBoolean("active", false)
                    if (!serverOk) {
                        val err = verified?.optString("error").orEmpty()
                            .ifBlank { "Purchase recorded in Google Play, but verification did not finish yet. Tap Restore Purchases to retry." }
                        mainHandler.post {
                            setPlanButtonsEnabled(true)
                            statusView.text = err
                        }
                        finishOp()
                        return@Thread
                    }

                    if (!purchase.isAcknowledged) {
                        mainHandler.post {
                            if (!client.isReady) {
                                setPlanButtonsEnabled(true)
                                statusView.text = "Purchase verified, waiting for Google Play confirmation — tap Restore Purchases to retry."
                                if (inFlightOps.decrementAndGet() <= 0) {
                                    safeEndConnectionIfIdle(client)
                                }
                                return@post
                            }
                            val ackParams = AcknowledgePurchaseParams.newBuilder()
                                .setPurchaseToken(token)
                                .build()
                            client.acknowledgePurchase(ackParams) { ackResult ->
                                if (ackResult.responseCode == BillingClient.BillingResponseCode.OK) {
                                    completeProUnlock()
                                } else {
                                    val detail = ackResult.debugMessage.takeIf { it.isNotBlank() }?.let { " ($it)" }.orEmpty()
                                    mainHandler.post {
                                        setPlanButtonsEnabled(true)
                                        statusView.text = "Purchase verified, but Google Play confirmation did not complete$detail. Tap Restore Purchases to retry."
                                    }
                                    finishOp()
                                }
                            }
                        }
                    } else {
                        completeProUnlock()
                    }
                }.start()
            }
        }

        val purchasesUpdatedListener = PurchasesUpdatedListener { billingResult, purchases ->
            when (billingResult.responseCode) {
                BillingClient.BillingResponseCode.OK -> {
                    if (!purchases.isNullOrEmpty()) {
                        billingClient?.let { handlePurchases(it, purchases, isRestore = false) }
                    }
                }
                BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED -> {
                    mainHandler.post {
                        statusView.text = "Subscription already owned on this Google account — syncing Pro access…"
                    }
                    billingClient?.let { activeClient ->
                        if (activeClient.isReady) {
                            val qParams = QueryPurchasesParams.newBuilder()
                                .setProductType(BillingClient.ProductType.SUBS)
                                .build()
                            activeClient.queryPurchasesAsync(qParams) { res, list ->
                                if (res.responseCode == BillingClient.BillingResponseCode.OK) {
                                    handlePurchases(activeClient, list, isRestore = true)
                                } else {
                                    mainHandler.post {
                                        setPlanButtonsEnabled(true)
                                        statusView.text = "Unable to sync your existing subscription right now. Tap Restore Purchases to retry."
                                    }
                                }
                            }
                        }
                    }
                }
                BillingClient.BillingResponseCode.USER_CANCELED -> {
                    mainHandler.post {
                        setPlanButtonsEnabled(true)
                        statusView.text = "No charge made — continue scanning free anytime."
                    }
                }
                else -> {
                    mainHandler.post {
                        setPlanButtonsEnabled(true)
                        statusView.text = billingResult.debugMessage.ifBlank { "Google Play Billing could not complete right now." }
                    }
                }
            }
        }

        val client = BillingClient.newBuilder(appCtx)
            .setListener(purchasesUpdatedListener)
            .enablePendingPurchases(
                PendingPurchasesParams.newBuilder()
                    .enableOneTimeProducts()
                    .build()
            )
            .build()
        billingClient = client

        fun loadGooglePlayPlans() {
            if (!client.isReady) {
                mainHandler.post {
                    statusView.text = "Connecting to Google Play…"
                    retryBtn.visibility = View.GONE
                }
                client.startConnection(object : BillingClientStateListener {
                    override fun onBillingSetupFinished(billingResult: BillingResult) {
                        if (billingResult.responseCode != BillingClient.BillingResponseCode.OK) {
                            mainHandler.post {
                                priceHeadlineView.text = "Google Play Billing unavailable"
                                priceSubView.text = "Tap Retry below, sign in to sync an existing Pro account, or continue free."
                                annualBtn.text = "Annual Plan — Unavailable"
                                monthlyBtn.text = "Monthly Plan — Unavailable"
                                setPlanButtonsEnabled(false)
                                retryBtn.visibility = View.VISIBLE
                                statusView.text = "Google Play Billing unavailable on this device right now."
                            }
                            return
                        }
                        loadGooglePlayPlans()
                    }

                    override fun onBillingServiceDisconnected() {
                        mainHandler.post {
                            retryBtn.visibility = View.VISIBLE
                            statusView.text = "Google Play connection interrupted — tap Retry to reconnect."
                        }
                    }
                })
                return
            }

            val productList = listOf(
                QueryProductDetailsParams.Product.newBuilder()
                    .setProductId(ANNUAL_PRODUCT_ID)
                    .setProductType(BillingClient.ProductType.SUBS)
                    .build(),
                QueryProductDetailsParams.Product.newBuilder()
                    .setProductId(MONTHLY_PRODUCT_ID)
                    .setProductType(BillingClient.ProductType.SUBS)
                    .build()
            )
            val params = QueryProductDetailsParams.newBuilder()
                .setProductList(productList)
                .build()
            client.queryProductDetailsAsync(params) { res, detailsList ->
                mainHandler.post {
                    if (res.responseCode == BillingClient.BillingResponseCode.OK) {
                        annualDetails = detailsList.firstOrNull { it.productId == ANNUAL_PRODUCT_ID }
                        monthlyDetails = detailsList.firstOrNull { it.productId == MONTHLY_PRODUCT_ID }
                        val annualOffer = extractOfferDisplay(annualDetails)
                        val monthlyOffer = extractOfferDisplay(monthlyDetails)

                        if (annualOffer != null) {
                            priceHeadlineView.text = "${annualOffer.recurringPrice}/year"
                            annualBtn.text = if (annualOffer.freeTrialLabel != null) {
                                "${annualOffer.recurringPrice}/year — Annual Plan\n${annualOffer.freeTrialLabel}, then ${annualOffer.recurringPrice}/year"
                            } else {
                                "${annualOffer.recurringPrice}/year — Annual Plan"
                            }
                        } else {
                            annualBtn.text = "Annual Plan — Unavailable"
                        }

                        if (monthlyOffer != null) {
                            monthlyBtn.text = if (monthlyOffer.freeTrialLabel != null) {
                                "${monthlyOffer.recurringPrice}/month — Monthly Plan\n${monthlyOffer.freeTrialLabel}, then ${monthlyOffer.recurringPrice}/month"
                            } else {
                                "${monthlyOffer.recurringPrice}/month — Monthly Plan"
                            }
                        } else {
                            monthlyBtn.text = "Monthly Plan — Unavailable"
                        }

                        if (annualOffer != null && monthlyOffer != null) {
                            priceSubView.text = annualOffer.freeTrialLabel?.let {
                                "or ${monthlyOffer.recurringPrice}/month • Includes $it for eligible new subscribers"
                            } ?: "or ${monthlyOffer.recurringPrice}/month • Billed through Google Play"
                            val trialClause = annualOffer.freeTrialLabel?.let { "$it for eligible new subscribers, then " }.orEmpty()
                            disclosureView.text = "Auto-renewable subscription billed through Google Play: $trialClause${annualOffer.recurringPrice}/year (or ${monthlyOffer.recurringPrice}/month). Subscription renews automatically unless canceled in Google Play → Payments & subscriptions before renewal."
                            cachedPricingSummary = "${annualOffer.recurringPrice}/year or ${monthlyOffer.recurringPrice}/month via Google Play. Cancel anytime in Google Play."
                            retryBtn.visibility = View.GONE
                            statusView.text = "Choose a Google Play plan below, or continue free anytime."
                        } else if (annualOffer != null) {
                            priceSubView.text = annualOffer.freeTrialLabel?.let {
                                "Includes $it for eligible new subscribers"
                            } ?: "Billed annually through Google Play"
                            val trialClause = annualOffer.freeTrialLabel?.let { "$it for eligible new subscribers, then " }.orEmpty()
                            disclosureView.text = "Auto-renewable subscription billed through Google Play: $trialClause${annualOffer.recurringPrice}/year. Subscription renews automatically unless canceled in Google Play → Payments & subscriptions before renewal."
                            cachedPricingSummary = "${annualOffer.recurringPrice}/year via Google Play. Cancel anytime in Google Play."
                            retryBtn.visibility = View.GONE
                            statusView.text = "Choose a Google Play plan below, or continue free anytime."
                        } else if (monthlyOffer != null) {
                            priceHeadlineView.text = "${monthlyOffer.recurringPrice}/month"
                            priceSubView.text = monthlyOffer.freeTrialLabel?.let {
                                "Includes $it for eligible new subscribers"
                            } ?: "Billed monthly through Google Play"
                            val trialClause = monthlyOffer.freeTrialLabel?.let { "$it for eligible new subscribers, then " }.orEmpty()
                            disclosureView.text = "Auto-renewable subscription billed through Google Play: $trialClause${monthlyOffer.recurringPrice}/month. Subscription renews automatically unless canceled in Google Play → Payments & subscriptions before renewal."
                            cachedPricingSummary = "${monthlyOffer.recurringPrice}/month via Google Play. Cancel anytime in Google Play."
                            retryBtn.visibility = View.GONE
                            statusView.text = "Choose a Google Play plan below, or continue free anytime."
                        } else {
                            priceHeadlineView.text = "Google Play plans unavailable"
                            priceSubView.text = "Localized plans could not be loaded in this region right now."
                            retryBtn.visibility = View.VISIBLE
                            statusView.text = "Google Play plans are currently unavailable. Tap Retry to try again."
                        }
                        setPlanButtonsEnabled(inFlightOps.get() == 0)
                    } else {
                        priceHeadlineView.text = "Unable to load Google Play plans"
                        priceSubView.text = "Check your connection and tap Retry below."
                        setPlanButtonsEnabled(false)
                        retryBtn.visibility = View.VISIBLE
                        statusView.text = "Unable to load Google Play plans right now."
                    }
                }
            }
        }

        fun launchPurchase(details: ProductDetails?) {
            if (inFlightOps.get() > 0) {
                statusView.text = "Finishing verification of your current purchase…"
                return
            }
            if (details == null) {
                Toast.makeText(activity, "Google Play plans are still loading. Please try again in a moment.", Toast.LENGTH_SHORT).show()
                return
            }
            if (!client.isReady) {
                statusView.text = "Reconnecting to Google Play…"
                loadGooglePlayPlans()
                return
            }
            val offerToken = details.subscriptionOfferDetails?.firstOrNull()?.offerToken
            if (offerToken.isNullOrBlank()) {
                statusView.text = "Selected Google Play subscription offer is currently unavailable."
                return
            }
            ScanApi.trackEvent(activity, "checkout_started")
            val productParams = BillingFlowParams.ProductDetailsParams.newBuilder()
                .setProductDetails(details)
                .setOfferToken(offerToken)
                .build()
            val flowParams = BillingFlowParams.newBuilder()
                .setProductDetailsParamsList(listOf(productParams))
                .build()
            val launchRes = client.launchBillingFlow(activity, flowParams)
            if (launchRes.responseCode != BillingClient.BillingResponseCode.OK) {
                statusView.text = launchRes.debugMessage.ifBlank { "Unable to open Google Play checkout right now." }
            }
        }

        annualBtn.setOnClickListener { launchPurchase(annualDetails) }
        monthlyBtn.setOnClickListener { launchPurchase(monthlyDetails) }
        retryBtn.setOnClickListener { loadGooglePlayPlans() }

        val card = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(18), dp(20), dp(18))
            setBackgroundColor(0xFFF8FAFC.toInt())
            addView(TextView(activity).apply {
                text = "🥦 HEYBROC FAMILY PRO"
                textSize = 11.5f
                setTypeface(null, Typeface.BOLD)
                setTextColor(0xFF0F7A4A.toInt())
            })
            addView(TextView(activity).apply {
                text = "HeyBroc Family Pro"
                textSize = 21f
                setTypeface(null, Typeface.BOLD)
                setTextColor(0xFF0F172A.toInt())
                setPadding(0, dp(4), 0, dp(10))
            })
            addView(LinearLayout(activity).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(14), dp(12), dp(14), dp(12))
                background = GradientDrawable().apply {
                    setColor(Color.WHITE)
                    setStroke(dp(2), 0xFF16A34A.toInt())
                    cornerRadius = dp(14).toFloat()
                }
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { bottomMargin = dp(10) }
                addView(priceHeadlineView)
                addView(priceSubView)
            })
            addView(TextView(activity).apply {
                text = "• Unlimited 1-Tap Clean Swaps across all 12 grocery stores\n• Live 0–100 score badges inside HeyBroc In-App Live Shop\n• Custom Family Watchlist & Allergy Alerts synced across devices"
                textSize = 12.5f
                setTextColor(0xFF14532D.toInt())
                setPadding(dp(12), dp(10), dp(12), dp(10))
                background = GradientDrawable().apply {
                    setColor(0xFFECFDF5.toInt())
                    setStroke(dp(1), 0xFF86EFAC.toInt())
                    cornerRadius = dp(12).toFloat()
                }
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { bottomMargin = dp(8) }
            })
            addView(statusView)
            addView(retryBtn)
            addView(annualBtn)
            addView(monthlyBtn)

            addView(LinearLayout(activity).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER
                addView(TextView(activity).apply {
                    text = "Restore Purchases"
                    textSize = 12.5f
                    setTypeface(null, Typeface.BOLD)
                    setTextColor(0xFF0F7A4A.toInt())
                    setPadding(dp(10), dp(8), dp(10), dp(8))
                    setOnClickListener {
                        if (!client.isReady) {
                            statusView.text = "Reconnecting to Google Play…"
                            loadGooglePlayPlans()
                            return@setOnClickListener
                        }
                        statusView.text = "Checking Google Play purchases…"
                        val qParams = QueryPurchasesParams.newBuilder()
                            .setProductType(BillingClient.ProductType.SUBS)
                            .build()
                        client.queryPurchasesAsync(qParams) { res, list ->
                            if (res.responseCode == BillingClient.BillingResponseCode.OK) {
                                handlePurchases(client, list, isRestore = true)
                            } else {
                                mainHandler.post { statusView.text = "Unable to query Google Play right now." }
                            }
                        }
                    }
                })
                addView(TextView(activity).apply {
                    text = "Manage Subscription"
                    textSize = 12.5f
                    setTextColor(0xFF475569.toInt())
                    setPadding(dp(10), dp(8), dp(10), dp(8))
                    setOnClickListener { openManageSubscription(activity) }
                })
            })

            addView(LinearLayout(activity).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER
                addView(TextView(activity).apply {
                    text = "Terms of Use"
                    textSize = 12f
                    setTypeface(null, Typeface.BOLD)
                    setTextColor(0xFF0F7A4A.toInt())
                    setPadding(dp(10), dp(4), dp(10), dp(4))
                    setOnClickListener {
                        runCatching { activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(TERMS_URL))) }
                    }
                })
                addView(TextView(activity).apply {
                    text = "Privacy Policy"
                    textSize = 12f
                    setTypeface(null, Typeface.BOLD)
                    setTextColor(0xFF0F7A4A.toInt())
                    setPadding(dp(10), dp(4), dp(10), dp(4))
                    setOnClickListener {
                        runCatching { activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(PRIVACY_URL))) }
                    }
                })
            })
            addView(disclosureView)
        }

        val scroll = ScrollView(activity).apply { addView(card) }
        val dlg = AlertDialog.Builder(activity)
            .setView(scroll)
            .setNegativeButton("Continue with Free Plan", null)
            .create()
        dlg.setOnDismissListener {
            dialogDismissed.set(true)
            pendingDisconnect.set(true)
            safeEndConnectionIfIdle(client)
        }
        dialogRef = dlg
        ScanApi.trackEvent(activity, "paywall_viewed")
        dlg.show()

        loadGooglePlayPlans()
    }
}
