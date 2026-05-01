#ifndef __ASC_H
#define __ASC_H

#ifdef ASCHEADER16
  #define NLEVEL  4  /*  number of level of the binary structure */
  #define N      16  /* (1<<NLEVEL),number of intervals along 1 lign         */
  #define SIZE   32  /* (1<<(NLEVEL+1)), number of dikes in binary tree stucture  */
  #define DSIZE  64  /* (1<<(NLEVEL+2)), double of SIZE */
#elif defined(ASCHEADER8)
  #define NLEVEL  3  /*  number of level of the binary structure */
  #define N       8  /* (1<<NLEVEL),number of intervals along 1 lign         */
  #define SIZE    16  /* (1<<(NLEVEL+1)), number of dikes in binary tree stucture  */
  #define DSIZE   32  /* (1<<(NLEVEL+2)), double of SIZE */
#elif defined(ASCHEADER4)
  #define NLEVEL  2  /*  number of level of the binary structure */
  #define N       4  /* (1<<NLEVEL),number of intervals along 1 lign         */
  #define SIZE    8  /* (1<<(NLEVEL+1)), number of dikes in binary tree stucture  */
  #define DSIZE   16  /* (1<<(NLEVEL+2)), double of SIZE */
#elif defined(ASCHEADER2)
  #define NLEVEL  1  /*  number of level of the binary structure */
  #define N       2  /* (1<<NLEVEL),number of intervals along 1 lign         */
  #define SIZE    4  /* (1<<(NLEVEL+1)), number of dikes in binary tree stucture  */
  #define DSIZE   8  /* (1<<(NLEVEL+2)), double of SIZE */
#else  // ASC1
  #define NLEVEL  0  /*  number of level of the binary structure */
  #define N       1  /* (1<<NLEVEL),number of intervals along 1 lign         */
  #define SIZE    2  /* (1<<(NLEVEL+1)), number of dikes in binary tree stucture  */
  #define DSIZE   4  /* (1<<(NLEVEL+2)), double of SIZE */
#endif


#endif

