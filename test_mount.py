import asyncio
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page(viewport={"width": 1280, "height": 900})

        script = """
        window.addEventListener('DOMContentLoaded', () => {
          if (window.firebase) {
            const mockAuth = () => ({
              onAuthStateChanged: (cb) => {
                cb({ uid: "test-user", email: "ally@example.com", displayName: "Ally" });
              },
              getRedirectResult: () => Promise.resolve({ user: null }),
              signInWithPopup: () => Promise.resolve(),
              signOut: () => Promise.resolve(),
            });
            window.firebase.auth = mockAuth;
            const mockDoc = () => ({
              onSnapshot: (cb) => { setTimeout(() => cb({ exists: false }), 50); return () => {}; },
              set: () => Promise.resolve(),
            });
            const mockFs = () => ({
              doc: mockDoc,
              collection: () => ({ doc: mockDoc }),
              runTransaction: (cb) => cb({ get: () => Promise.resolve({ exists: false }), set: () => {} }),
            });
            window.firebase.firestore = mockFs;
          }
        });
        """
        await page.add_init_script(script)
        await page.goto("http://localhost:8000")
        await page.wait_for_timeout(3000)

        # Verify 0 date inputs
        date_inputs = await page.query_selector_all("input[type='date']")
        print(f"Date inputs count: {len(date_inputs)}")
        assert len(date_inputs) == 0

        await page.screenshot(path="screenshot_final.png", full_page=True)
        print("Final screenshot saved to screenshot_final.png")
        await browser.close()

asyncio.run(main())
