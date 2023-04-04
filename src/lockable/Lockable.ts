

class Lockable {

    private lockedTill = 0;
    private lockNonce = 0;

    lock(timeoutSeconds: number): (() => boolean) | null {
        if(this.isLocked()) {
            return null;
        }

        this.lockedTill = Date.now()+(timeoutSeconds*1000);

        this.lockNonce++;
        const lockNonce = this.lockNonce;
        return () => {
            if(this.lockNonce!==lockNonce) {
                return false;
            }
            this.lockedTill = 0;
            return true;
        };
    }

    isLocked(): boolean {
        return this.lockedTill>Date.now();
    }

}

export default Lockable;