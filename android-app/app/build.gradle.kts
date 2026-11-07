plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val apiBase: String = (project.findProperty("cleancartApiBase") as String?) ?: "https://heybroc.com"

android {
    namespace = "com.cleancart.overlay"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.cleancart.overlay"
        minSdk = 26
        targetSdk = 36
        versionCode = 7
        versionName = "1.6.0"
        buildConfigField("String", "API_BASE", "\"$apiBase\"")
    }

    signingConfigs {
        getByName("debug") {
            storeFile = file("heybroc.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }

    buildFeatures { buildConfig = true }

    lint {
        abortOnError = true
        checkOnly.add("NewApi")
        checkReleaseBuilds = false
    }

    buildTypes {
        debug {
            signingConfig = signingConfigs.getByName("debug")
        }
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

// No third-party dependencies: plain Android framework views + HttpURLConnection + org.json.
