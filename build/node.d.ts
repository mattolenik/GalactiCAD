// Define the execve function of Node v23.11.0 https://nodejs.org/api/process.html#processexecvefile-args-env
declare namespace NodeJS {
    interface Process {
        execve(path: string, args: string[], env: {}): never
    }
}
